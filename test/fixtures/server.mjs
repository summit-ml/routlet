// A stand-in for an unmodified app: listens on PORT, reports what it saw, echoes upgrades.
import http from 'node:http';

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      label: process.env.LABEL,
      host: req.headers.host,
      forwardedHost: req.headers['x-forwarded-host'],
      path: req.url,
      apiUrl: process.env.API_URL,
      selfUrl: process.env.SELF_URL,
      port: server.address().port,
    }),
  );
});

server.on('upgrade', (_req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  socket.pipe(socket);
});

// IGNORE_PORT simulates an app that picks its own port no matter what it is told.
server.listen(process.env.IGNORE_PORT ? 0 : Number(process.env.PORT), '127.0.0.1');
