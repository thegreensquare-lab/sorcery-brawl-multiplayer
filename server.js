const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Sorcery Brawl multiplayer server is online!");
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();

wss.on("connection", (socket) => {
  let room = null;

  socket.on("message", (data) => {
    let message;

    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Join a room
    if (message.type === "join") {
      const roomId = String(message.room || "").trim();

      if (!roomId) return;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }

      room = rooms.get(roomId);

      // Only allow two players per room
      if (room.size >= 2) {
        socket.send(JSON.stringify({
          type: "room-full"
        }));
        return;
      }

      room.add(socket);

      socket.send(JSON.stringify({
        type: "joined",
        players: room.size
      }));

      // Tell the other player that someone joined
      for (const player of room) {
        if (player !== socket && player.readyState === WebSocket.OPEN) {
          player.send(JSON.stringify({
            type: "player-joined",
            players: room.size
          }));
        }
      }

      return;
    }

    // Relay game data to the other player
    if (message.type === "game" && room) {
      for (const player of room) {
        if (player !== socket && player.readyState === WebSocket.OPEN) {
          player.send(JSON.stringify({
            type: "game",
            data: message.data
          }));
        }
      }
    }
  });

  socket.on("close", () => {
    if (!room) return;

    room.delete(socket);

    for (const player of room) {
      if (player.readyState === WebSocket.OPEN) {
        player.send(JSON.stringify({
          type: "player-left"
        }));
      }
    }

    if (room.size === 0) {
      for (const [id, players] of rooms) {
        if (players === room) {
          rooms.delete(id);
          break;
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sorcery Brawl server running on port ${PORT}`);
});
