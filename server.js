const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const SHAPES = [
  "circle",
  "square",
  "triangle",
  "rhombus",
  "star"
];

const PET_TYPES = [1, 2, 3];

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Sorcery Brawl multiplayer server is online!");
});

const wss = new WebSocket.Server({ server });

function broadcast(room, message, except = null) {
  for (const player of room.players) {
    if (
      player !== except &&
      player.socket.readyState === WebSocket.OPEN
    ) {
      player.socket.send(JSON.stringify(message));
    }
  }
}

function cleanupRoom(roomId, room) {
  if (room.players.length === 0) {
    rooms.delete(roomId);
  }
}

wss.on("connection", (socket) => {
  let roomId = null;
  let player = null;

  socket.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // =========================
    // JOIN ROOM
    // =========================
    if (message.type === "join") {
      roomId = String(message.room || "").trim();

      if (!roomId) return;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          players: []
        });
      }

      const room = rooms.get(roomId);

      // Maximum of two players
      if (room.players.length >= 2) {
        socket.send(
          JSON.stringify({
            type: "room-full"
          })
        );

        return;
      }

      player = {
        socket,
        number: room.players.length + 1,
        ready: false,
        shape: null,
        randomShape: false
      };

      room.players.push(player);

      // Tell this player their player number
      socket.send(
        JSON.stringify({
          type: "joined",
          players: room.players.length,
          playerNumber: player.number
        })
      );

      // Tell the other player that someone joined
      if (room.players.length === 2) {
        broadcast(
          room,
          {
            type: "player-joined",
            players: 2
          },
          socket
        );
      }

      return;
    }

    if (!player || !roomId) return;

    const room = rooms.get(roomId);

    if (!room) return;

    // =========================
    // PLAYER READY
    // =========================
    if (message.type === "ready") {
      const shape = String(message.shape || "");

      if (
        !SHAPES.includes(shape) &&
        shape !== "random"
      ) {
        return;
      }

      player.randomShape = shape === "random";

      player.shape = player.randomShape
        ? null
        : shape;

      player.ready = true;

      const opponent = room.players.find(
        (p) => p !== player
      );

      // Tell this player whether the opponent is ready
      socket.send(
        JSON.stringify({
          type: "ready-state",
          opponentReady: !!(
            opponent &&
            opponent.ready
          )
        })
      );

      // Tell the opponent that this player is ready
      if (opponent) {
        opponent.socket.send(
          JSON.stringify({
            type: "ready-state",
            opponentReady: true
          })
        );
      }

      // =========================
      // BOTH PLAYERS READY
      // =========================
      if (
        room.players.length === 2 &&
        room.players.every((p) => p.ready)
      ) {
        const p1 = room.players.find(
          (p) => p.number === 1
        );

        const p2 = room.players.find(
          (p) => p.number === 2
        );

        // Server chooses Random characters.
        // This means BOTH computers get the
        // exact same random result.
        if (p1.randomShape) {
          p1.shape = randomFrom(SHAPES);
        }

        if (p2.randomShape) {
          p2.shape = randomFrom(SHAPES);
        }

        broadcast(room, {
          type: "match-start",

          p1Shape: p1.shape,
          p2Shape: p2.shape,

          p1Random: p1.randomShape,
          p2Random: p2.randomShape
        });
      }

      return;
    }

    // =========================
    // MEGUMI SHIKIGAMI
    // =========================
    if (message.type === "megumi-pet-request") {
      const targetNumber = Number(
        message.playerNumber
      );

      if (
        targetNumber !== 1 &&
        targetNumber !== 2
      ) {
        return;
      }

      const target = room.players.find(
        (p) => p.number === targetNumber
      );

      if (!target) return;

      // Make sure only that player can request
      // their own Shikigami.
      if (target.socket !== socket) {
        return;
      }

      const petType = randomFrom(PET_TYPES);

      // Send the SAME Shikigami result to both
      // computers.
      broadcast(room, {
        type: "megumi-pet-type",
        playerNumber: targetNumber,
        petType: petType
      });

      return;
    }

    // =========================
    // NEXT ROUND
    // =========================
    if (message.type === "next-round") {
      if (room.players.length !== 2) {
        return;
      }

      const p1 = room.players.find(
        (p) => p.number === 1
      );

      const p2 = room.players.find(
        (p) => p.number === 2
      );

      if (!p1 || !p2) {
        return;
      }

      // Re-randomize only if the player originally
      // selected Random.
      if (p1.randomShape) {
        p1.shape = randomFrom(SHAPES);
      }

      if (p2.randomShape) {
        p2.shape = randomFrom(SHAPES);
      }

      // Send the same matchup to both players.
      broadcast(room, {
        type: "round-reset",

        p1Shape: p1.shape,
        p2Shape: p2.shape,

        p1Random: p1.randomShape,
        p2Random: p2.randomShape
      });

      return;
    }

    // =========================
    // GAME DATA
    // =========================
    if (message.type === "game") {
      /*
       * The server identifies the sender by their
       * WebSocket connection.
       *
       * Therefore:
       *
       * Player 1 pressing W
       * does NOT control Player 2.
       *
       * Player 2 pressing W
       * does NOT control Player 1.
       *
       * Same for V, B and N.
       */

      broadcast(
        room,
        {
          type: "game",
          data: message.data
        },
        socket
      );

      return;
    }
  });

  // =========================
  // PLAYER DISCONNECTS
  // =========================
  socket.on("close", () => {
    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    room.players = room.players.filter(
      (p) => p.socket !== socket
    );

    broadcast(room, {
      type: "player-left"
    });

    cleanupRoom(roomId, room);
  });
});

// =========================
// START SERVER
// =========================

server.listen(PORT, () => {
  console.log(
    `Sorcery Brawl server running on port ${PORT}`
  );
});
