
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const rooms = new Map();

// Keep these IDs in sync with the character IDs used by the client.
// Random includes every supported character, including Todo/Yuji.
const SHAPES = [
  "circle",   // Gojo
  "square",   // Choso
  "triangle", // Naoya
  "rhombus",  // Sukuna
  "star",     // Megumi
  "pentagon", // Hakari
  "plus",     // Yuta
  "x",        // Nobara
  "octagon"   // Todo / Yuji
];

const PET_TYPES = [1, 2, 3];

/*
====================================================
UTILITY FUNCTIONS
====================================================
*/

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function send(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(room, message, except = null) {
  if (!room) return;

  for (const player of room.players) {
    if (player.socket === except) continue;
    send(player.socket, message);
  }
}

/*
====================================================
HTTP SERVER
====================================================
*/

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("Sorcery Brawl multiplayer server is online!");
});

/*
====================================================
WEBSOCKET SERVER
====================================================
*/

const wss = new WebSocket.Server({ server });

/*
====================================================
CHARACTER SELECTION
====================================================
*/

function chooseShape(player) {
  if (!player || !player.selectedShape) return null;

  if (player.selectedShape === "random") {
    // Avoid repeating the same character in consecutive rounds.
    const choices = SHAPES.filter(shape => shape !== player.shape);
    return randomFrom(choices.length ? choices : SHAPES);
  }

  return SHAPES.includes(player.selectedShape)
    ? player.selectedShape
    : null;
}

/*
====================================================
START MATCH
====================================================
*/

function startMatch(room) {
  if (!room || room.players.length !== 2) return;

  if (!room.players.every(player => player.ready)) return;

  // Make sure both players selected a valid character.
  if (!room.players.every(player =>
    SHAPES.includes(player.selectedShape) ||
    player.selectedShape === "random"
  )) {
    return;
  }

  const p1 = room.players.find(player => player.number === 1);
  const p2 = room.players.find(player => player.number === 2);

  if (!p1 || !p2) return;

  // Resolve Random once on the server so both clients agree.
  p1.shape = chooseShape(p1);
  p2.shape = chooseShape(p2);

  room.roundEndHandled = false;

  broadcast(room, {
    type: "match-start",
    p1Shape: p1.shape,
    p2Shape: p2.shape,
    p1Random: p1.selectedShape === "random",
    p2Random: p2.selectedShape === "random"
  });
}

/*
====================================================
RESET FOR NEXT ROUND
====================================================
*/

function resetForNextRound(room) {
  if (!room || room.players.length !== 2) return;

  const p1 = room.players.find(player => player.number === 1);
  const p2 = room.players.find(player => player.number === 2);

  if (!p1 || !p2) return;

  // Players who chose Random get a new character.
  // Players who chose a specific character keep it.
  p1.shape = chooseShape(p1);
  p2.shape = chooseShape(p2);

  room.roundEndHandled = false;

  broadcast(room, {
    type: "round-reset",
    p1Shape: p1.shape,
    p2Shape: p2.shape,
    p1Random: p1.selectedShape === "random",
    p2Random: p2.selectedShape === "random"
  });
}

/*
====================================================
WEBSOCKET CONNECTION
====================================================
*/

wss.on("connection", socket => {
  let roomId = null;
  let player = null;

  socket.on("message", raw => {
    let message;

    // Safely parse incoming JSON.
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!message || typeof message !== "object") return;

    /*
    ==================================================
    JOIN ROOM
    ==================================================
    */

    if (message.type === "join") {
      roomId = String(message.room || "").trim();

      if (!roomId) return;

      // Create room if it doesn't exist.
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          players: [],
          roundEndHandled: false,
          megumiPets: {}
        });
      }

      const room = rooms.get(roomId);

      // Only two players are allowed.
      if (room.players.length >= 2) {
        send(socket, { type: "room-full" });
        return;
      }

      // The server assigns the player number.
      player = {
        socket,
        number: room.players.length + 1,
        ready: false,
        selectedShape: null,
        shape: null
      };

      room.players.push(player);

      send(socket, {
        type: "joined",
        players: room.players.length,
        playerNumber: player.number
      });

      // Tell Player 1 when Player 2 joins.
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

    /*
    ==================================================
    REQUIRE PLAYER TO BE IN A ROOM
    ==================================================
    */

    if (!player || !roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    /*
    ==================================================
    CHARACTER SELECTION
    ==================================================
    */

    if (message.type === "select-character") {
      const shape = String(message.shape || "").toLowerCase();

      // Only allow supported characters or Random.
      if (!SHAPES.includes(shape) && shape !== "random") {
        return;
      }

      // Don't allow changing character after Ready.
      if (player.ready) return;

      player.selectedShape = shape;
      player.shape = null;

      send(socket, {
        type: "character-selected",
        playerNumber: player.number,
        shape
      });

      return;
    }

    /*
    ==================================================
    READY
    ==================================================
    */

    if (message.type === "ready") {
      if (!player.selectedShape) {
        send(socket, {
          type: "error",
          message: "Choose a character before Ready."
        });
        return;
      }

      player.ready = true;

      const opponent = room.players.find(p => p !== player);

      send(socket, {
        type: "ready-state",
        playerNumber: player.number,
        ready: true,
        opponentReady: !!(opponent && opponent.ready)
      });

      if (opponent) {
        send(opponent.socket, {
          type: "ready-state",
          playerNumber: player.number,
          ready: true,
          opponentReady: true
        });
      }

      startMatch(room);
      return;
    }

    /*
    ==================================================
    CANCEL READY
    ==================================================
    */

    if (message.type === "cancel-ready") {
      player.ready = false;

      send(socket, {
        type: "ready-state",
        playerNumber: player.number,
        ready: false,
        opponentReady: false
      });

      const opponent = room.players.find(p => p !== player);

      if (opponent) {
        send(opponent.socket, {
          type: "ready-state",
          playerNumber: player.number,
          ready: false,
          opponentReady: !!opponent.ready
        });
      }

      return;
    }

    /*
    ==================================================
    MEGUMI SHIKIGAMI
    ==================================================
    */

    if (message.type === "megumi-pet-request") {
      const targetNumber = Number(message.playerNumber);

      // A player can only request a Shikigami for themselves.
      if (targetNumber !== player.number) return;

      const petType = randomFrom(PET_TYPES);
      room.megumiPets[targetNumber] = petType;

      // Send the same random result to both computers.
      broadcast(room, {
        type: "megumi-pet-type",
        playerNumber: targetNumber,
        petType
      });

      return;
    }

    /*
    ==================================================
    ROUND END
    ==================================================
    */

    if (message.type === "round-end") {
      const winnerNumber = Number(message.winnerNumber);

      // Only Player 1 or Player 2 can win.
      if (winnerNumber !== 1 && winnerNumber !== 2) return;

      // Prevent the same round ending more than once.
      if (room.roundEndHandled) return;

      room.roundEndHandled = true;

      broadcast(room, {
        type: "round-end",
        winnerNumber
      });

      return;
    }

    /*
    ==================================================
    NEXT ROUND
    ==================================================
    */

    if (message.type === "next-round") {
      if (!room.roundEndHandled || room.players.length !== 2) {
        return;
      }

      // Clear old Megumi selections for the next round.
      room.megumiPets = {};

      resetForNextRound(room);
      return;
    }

    /*
    ==================================================
    GAME EVENT RELAY
    ==================================================

    Combat events are relayed to the opponent.
    The server attaches the sender's player number.

    Damage events can look like:
    {
      type: "game",
      data: {
        kind: "damage",
        targetPlayerNumber: 2,
        amount: 20,
        attackType: "cleave"
      }
    }
    */

    if (message.type === "game") {
      if (!message.data || typeof message.data !== "object") {
        return;
      }

      const gameData = { ...message.data };

      // Validate player damage events.
      if (gameData.kind === "damage") {
        const targetPlayerNumber = Number(
          gameData.targetPlayerNumber
        );

        if (targetPlayerNumber !== 1 && targetPlayerNumber !== 2) {
          return;
        }

        // Prevent a player from sending damage to themselves.
        if (targetPlayerNumber === player.number) return;

        const amount = Number(gameData.amount);

        if (!Number.isFinite(amount) || amount <= 0) {
          return;
        }

        gameData.amount = amount;
        gameData.targetPlayerNumber = targetPlayerNumber;
      }

      // Send this event to the opponent, not back to the sender.
      broadcast(
        room,
        {
          type: "game",
          playerNumber: player.number,
          data: gameData
        },
        socket
      );

      return;
    }

    /*
    ==================================================
    PING
    ==================================================
    */

    if (message.type === "ping") {
      send(socket, { type: "pong" });
      return;
    }
  });

  /*
  ==================================================
  PLAYER DISCONNECT
  ==================================================
  */

  socket.on("close", () => {
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // Remove the disconnected player.
    room.players = room.players.filter(p => p.socket !== socket);

    // Reset round-specific server state.
    room.roundEndHandled = false;
    room.megumiPets = {};

    // Tell the remaining player their opponent disconnected.
    broadcast(room, {
      type: "player-left"
    });

    // Delete empty rooms.
    if (room.players.length === 0) {
      rooms.delete(roomId);
    }
  });
});

/*
====================================================
START SERVER
====================================================
*/

server.listen(PORT, () => {
  console.log(`Sorcery Brawl server running on port ${PORT}`);
});
