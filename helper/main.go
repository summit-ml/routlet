// routlet-helper gives services a stable address and reverse-proxies each one
// to whatever localhost port its app is currently using.
//
// It runs in one of two modes:
//
//	local    One process per service, listening on a fixed 127.0.0.1 port.
//	         Driven over stdin/stdout.
//	gateway  One long-lived process per machine. It joins the tailnet as a
//	         single tagged device and hosts a Tailscale Service for every
//	         registered name. Driven over a Unix socket, one connection per
//	         service; closing the connection takes that service offline.
//
// Both speak the same protocol, one JSON object per line.
//
//	to helper:   {"register":"api"}             gateway only, first message
//	             {"prefetch":true}              gateway only, after approval
//	             {"target":"localhost:5173"}    sets or changes the upstream
//	from helper: {"event":"advertised","fqdn":...,"nodeId":...}
//	             {"event":"info","message":...}
//	             {"event":"ready","url":...,"hostname":...}
//	             {"event":"error","code":...,"message":...}
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/tsnet"
)

type message struct {
	Register string `json:"register"`
	Prefetch bool   `json:"prefetch"`
	Target   string `json:"target"`
}

// emitter writes protocol events to one peer.
type emitter struct {
	mu sync.Mutex
	w  io.Writer
}

func (e *emitter) emit(fields map[string]any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	b, _ := json.Marshal(fields)
	e.w.Write(append(b, '\n'))
}

func (e *emitter) info(message string) {
	e.emit(map[string]any{"event": "info", "message": message})
}

func (e *emitter) fail(code, message string) {
	e.emit(map[string]any{"event": "error", "code": code, "message": message})
}

func proxy(target *atomic.Pointer[url.URL]) http.Handler {
	rp := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target.Load())
			// Keep the public hostname so apps build correct absolute URLs.
			r.Out.Host = r.In.Host
			r.SetXForwarded()
		},
		// Flush immediately: dev servers stream (SSE, chunked SSR).
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, "routlet: the app is not responding ("+err.Error()+")", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if target.Load() == nil {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "routlet: the app is still starting", http.StatusServiceUnavailable)
			return
		}
		rp.ServeHTTP(w, r)
	})
}

func setTarget(target *atomic.Pointer[url.URL], hostport string) {
	target.Store(&url.URL{Scheme: "http", Host: hostport})
}

// ---- local mode ----

func serveLocal(listen string) {
	out := &emitter{w: os.Stdout}
	var target atomic.Pointer[url.URL]
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			var msg message
			if json.Unmarshal(scanner.Bytes(), &msg) == nil && msg.Target != "" {
				setTarget(&target, msg.Target)
			}
		}
		os.Exit(0) // the parent went away
	}()

	ln, err := net.Listen("tcp", listen)
	if err != nil {
		out.fail("listen_failed", "cannot listen on "+listen+": "+err.Error())
		os.Exit(1)
	}
	addr := ln.Addr().String()
	out.emit(map[string]any{"event": "ready", "url": "http://" + addr, "hostname": addr})
	log.Fatal(http.Serve(ln, proxy(&target)))
}

// ---- gateway mode ----

// idleExit is how long the gateway stays up with nothing registered.
// ROUTLET_GATEWAY_IDLE_SECONDS overrides it.
var idleExit = 10 * time.Minute

var serviceName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

type gateway struct {
	srv    *tsnet.Server
	lc     *local.Client
	active atomic.Int32
}

func serveGateway(dir, socket, hostname string) {
	// Only one gateway per machine: the tailnet device cannot be shared.
	lock, err := os.OpenFile(socket+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		log.Fatalf("cannot open lock: %v", err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		log.Printf("another gateway is already running")
		return
	}

	srv := &tsnet.Server{Hostname: hostname, Dir: dir, UserLogf: log.Printf}
	if os.Getenv("ROUTLET_DEBUG") == "" {
		srv.Logf = func(string, ...any) {}
	}
	if key := os.Getenv("TS_AUTHKEY"); key != "" {
		srv.AuthKey = key
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	_, err = srv.Up(ctx)
	cancel()
	if err != nil {
		log.Fatalf("could not join the tailnet: %v", err)
	}
	lc, err := srv.LocalClient()
	if err != nil {
		log.Fatalf("local client: %v", err)
	}

	os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		log.Fatalf("cannot listen on %s: %v", socket, err)
	}
	os.Chmod(socket, 0o600)
	log.Printf("gateway ready as %q", hostname)

	if secs, err := strconv.Atoi(os.Getenv("ROUTLET_GATEWAY_IDLE_SECONDS")); err == nil && secs > 0 {
		idleExit = time.Duration(secs) * time.Second
	}
	g := &gateway{srv: srv, lc: lc}
	go g.exitWhenIdle(socket)
	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Fatalf("accept: %v", err)
		}
		go g.handle(conn)
	}
}

// exitWhenIdle stops the gateway once nothing has been registered for a while,
// so it does not linger after the last dev server is closed.
func (g *gateway) exitWhenIdle(socket string) {
	idleSince := time.Now()
	for range time.Tick(5 * time.Second) {
		if g.active.Load() > 0 {
			idleSince = time.Now()
		} else if time.Since(idleSince) > idleExit {
			log.Printf("idle, shutting down")
			os.Remove(socket)
			g.srv.Close()
			os.Exit(0)
		}
	}
}

func (g *gateway) handle(conn net.Conn) {
	defer conn.Close()
	g.active.Add(1)
	defer g.active.Add(-1)

	out := &emitter{w: conn}
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		return
	}
	var first message
	if json.Unmarshal(scanner.Bytes(), &first) != nil || !serviceName.MatchString(first.Register) {
		out.fail("usage", "expected a register message with a valid service name")
		return
	}
	name := first.Register

	ln, err := g.srv.ListenService("svc:"+name, tsnet.ServiceModeHTTP{HTTPS: true, Port: 443})
	if err != nil {
		code := "service_failed"
		if errors.Is(err, tsnet.ErrUntaggedServiceHost) {
			code = "untagged_host"
		}
		out.fail(code, "cannot host the service "+name+": "+err.Error())
		return
	}
	// Closing the listener withdraws the service from this device.
	defer ln.Close()
	log.Printf("hosting %s", ln.FQDN)
	defer log.Printf("released %s", ln.FQDN)

	var target atomic.Pointer[url.URL]
	go http.Serve(ln, proxy(&target))

	nodeID := ""
	if st, err := g.lc.StatusWithoutPeers(context.Background()); err == nil && st.Self != nil {
		nodeID = string(st.Self.ID)
	}
	out.emit(map[string]any{"event": "advertised", "fqdn": ln.FQDN, "nodeId": nodeID})

	for scanner.Scan() {
		var msg message
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		if msg.Target != "" {
			setTarget(&target, msg.Target)
		}
		if msg.Prefetch {
			go g.prefetch(out, ln.FQDN)
		}
	}
}

// prefetch gets the service's certificate before announcing it, so "ready"
// means the first request is fast. It is cached after the first run.
func (g *gateway) prefetch(out *emitter, fqdn string) {
	done := make(chan struct{})
	go func() {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			out.info("Getting an HTTPS certificate for " + fqdn + " (first time only, can take a minute).")
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	var err error
	for {
		if _, _, err = g.lc.CertPair(ctx, fqdn); err == nil || ctx.Err() != nil {
			break
		}
		// The name may not be usable until the host's approval has propagated.
		time.Sleep(3 * time.Second)
	}
	close(done)
	if err != nil {
		out.fail("cert_failed", "could not get an HTTPS certificate for "+fqdn+": "+err.Error())
		return
	}
	out.emit(map[string]any{"event": "ready", "url": "https://" + fqdn, "hostname": fqdn})
}

func main() {
	mode := flag.String("mode", "", "local or gateway")
	listen := flag.String("listen", "127.0.0.1:0", "local: listen address")
	dir := flag.String("dir", "", "gateway: tailnet state directory")
	socket := flag.String("socket", "", "gateway: Unix socket path")
	hostname := flag.String("hostname", "routlet", "gateway: tailnet device name")
	flag.Parse()

	switch *mode {
	case "local":
		// Ctrl-C reaches the whole terminal process group. The parent decides
		// when the helper stops, so the URL stays up while the app shuts down.
		signal.Ignore(os.Interrupt)
		log.SetOutput(io.Discard)
		serveLocal(*listen)
	case "gateway":
		if *dir == "" || *socket == "" {
			log.Fatal("--dir and --socket are required in gateway mode")
		}
		signal.Ignore(os.Interrupt, syscall.SIGHUP)
		serveGateway(*dir, *socket, *hostname)
	default:
		log.Fatalf("unknown mode %q", *mode)
	}
}
