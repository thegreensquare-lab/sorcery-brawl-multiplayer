const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const SHAPES = ["circle", "square", "triangle", "rhombus", "star"];
const PET_TYPES = [1, 2, 3];

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

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("Sorcery Brawl multiplayer server is online!");
});

const wss = new WebSocket.Server({
  server
});

function chooseShape(player) {
  if (!player || !player.selectedShape) {
    return null;
  }

  if (player.selectedShape === "random") {
    return randomFrom(SHAPES);
  }

  return player.selectedShape;
}

function startMatch(room) {
  if (!room || room.players.length !== 2) {
    return;
  }

  if (!room.players.every(p => p.ready)) {
    return;
  }

  if (
    !room.players.every(
      p =>
        SHAPES.includes(p.selectedShape) ||
        p.selectedShape === "random"
    )
  ) {
    return;
  }

  const p1 = room.players.find(
    p => p.number === 1
  );

  const p2 = room.players.find(
    p => p.number === 2
  );

  if (!p1 || !p2) {
    return;
  }

  // Resolve Random exactly once on the server.
  p1.shape = chooseShape(p1);
  p2.shape = chooseShape(p2);

  room.roundEndHandled = false;

  const payload = {
    type: "match-start",

    p1Shape: p1.shape,
    p2Shape: p2.shape,

    p1Random:
      p1.selectedShape === "random",

    p2Random:
      p2.selectedShape === "random"
  };

  broadcast(room, payload);
}

function resetForNextRound(room) {
  if (!room || room.players.length !== 2) {
    return;
  }

  const p1 = room.players.find(
    p => p.number === 1
  );

  const p2 = room.players.find(
    p => p.number === 2
  );

  if (!p1 || !p2) {
    return;
  }

  // Re-roll only players who originally chose Random.
  p1.shape = chooseShape(p1);
  p2.shape = chooseShape(p2);

  room.roundEndHandled = false;

  broadcast(room, {
    type: "round-reset",

    p1Shape: p1.shape,
    p2Shape: p2.shape,

    p1Random:
      p1.selectedShape === "random",

    p2Random:
      p2.selectedShape === "random"
  });
}

wss.on("connection", socket => {
  let roomId = null;
  let player = null;

  socket.on("message", raw => {
    let message;

    try {
      message = JSON.parse(
        raw.toString()
      );
    } catch {
      return;
    }

    if (
      !message ||
      typeof message !== "object"
    ) {
      return;
    }

    /*
    ==================================================
    JOIN ROOM
    ==================================================
    */

    if (message.type === "join") {
      roomId = String(
        message.room || ""
      ).trim();

      if (!roomId) {
        return;
      }

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          players: [],
          roundEndHandled: false,
          megumiPets: {}
        });
      }

      const room = rooms.get(roomId);

      if (room.players.length >= 2) {
        send(socket, {
          type: "room-full"
        });

        return;
      }

      player = {
        socket,

        number:
          room.players.length + 1,

        ready: false,

        /*
          This is deliberately separate from
          the actual in-game character.

          It prevents the game's default Choso
          character from being used accidentally.
        */

        selectedShape: null,

        shape: null
      };

      room.players.push(player);

      send(socket, {
        type: "joined",

        players:
          room.players.length,

        playerNumber:
          player.number
      });

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

    if (!player || !roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    /*
    ==================================================
    CHARACTER SELECTION
    ==================================================

    This is the important fix.

    The selected character is stored separately
    for THIS socket.

    Player 1 can therefore select one character
    while Player 2 selects another.
    */

    if (
      message.type ===
      "select-character"
    ) {
      const shape = String(
        message.shape || ""
      ).toLowerCase();

      if (
        !SHAPES.includes(shape) &&
        shape !== "random"
      ) {
        return;
      }

      /*
        Don't allow changing character after
        clicking Ready.
      */

      if (player.ready) {
        return;
      }

      player.selectedShape = shape;

      /*
        Do NOT set player.shape here.

        player.shape is reserved for the actual
        character used in the match.
      */

      player.shape = null;

      /*
        Only tell this browser that its selection
        was accepted.
      */

      send(socket, {
        type: "character-selected",

        playerNumber:
          player.number,

        shape
      });

      return;
    }

    /*
    ==================================================
    READY
    ==================================================
    */

    if (
      message.type === "ready"
    ) {
      /*
        IMPORTANT:

        We completely ignore any character sent
        inside the Ready message.

        The server uses the character previously
        stored by select-character.
      */

      if (!player.selectedShape) {
        send(socket, {
          type: "error",

          message:
            "Choose a character before Ready."
        });

        return;
      }

      player.ready = true;

      const opponent =
        room.players.find(
          p => p !== player
        );

      send(socket, {
        type: "ready-state",

        playerNumber:
          player.number,

        ready: true,

        opponentReady:
          !!(
            opponent &&
            opponent.ready
          )
      });

      if (opponent) {
        send(
          opponent.socket,

          {
            type: "ready-state",

            playerNumber:
              player.number,

            ready: true,

            opponentReady: true
          }
        );
      }

      /*
        Only start once BOTH players have:

        1. joined
        2. selected a character
        3. clicked Ready
      */

      startMatch(room);

      return;
    }

    /*
    ==================================================
    CANCEL READY
    ==================================================
    */

    if (
      message.type ===
      "cancel-ready"
    ) {
      player.ready = false;

      send(socket, {
        type: "ready-state",

        playerNumber:
          player.number,

        ready: false,

        opponentReady: false
      });

      const opponent =
        room.players.find(
          p => p !== player
        );

      if (opponent) {
        send(
          opponent.socket,

          {
            type: "ready-state",

            playerNumber:
              player.number,

            ready: false,

            opponentReady:
              !!opponent.ready
          }
        );
      }

      return;
    }

    /*
    ==================================================
    MEGUMI SHIKIGAMI
    ==================================================
    */

    if (
      message.type ===
      "megumi-pet-request"
    ) {
      const targetNumber =
        Number(
          message.playerNumber
        );

      /*
        A player can only request a Shikigami
        for themselves.
      */

      if (
        targetNumber !==
        player.number
      ) {
        return;
      }

      const petType =
        randomFrom(PET_TYPES);

      room.megumiPets[
        targetNumber
      ] = petType;

      /*
        Both computers receive the same result.
      */

      broadcast(room, {
        type:
          "megumi-pet-type",

        playerNumber:
          targetNumber,

        petType
      });

      return;
    }

    /*
    ==================================================
    ROUND END
    ==================================================
    */

    if (
      message.type ===
      "round-end"
    ) {
      const winnerNumber =
        Number(
          message.winnerNumber
        );

      if (
        winnerNumber !== 1 &&
        winnerNumber !== 2
      ) {
        return;
      }

      /*
        Prevent the same round from being
        counted twice.
      */

      if (room.roundEndHandled) {
        return;
      }

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

    if (
      message.type ===
      "next-round"
    ) {
      if (
        !room.roundEndHandled ||
        room.players.length !== 2
      ) {
        return;
      }

      /*
        Clear old Megumi selections so the next
        round can choose a fresh Shikigami.
      */

      room.megumiPets = {};

      resetForNextRound(room);

      return;
    }

    /*
    ==================================================
    GAME STATE RELAY
    ==================================================
    */

    if (
      message.type === "game"
    ) {
      /*
        Send this player's game state ONLY to
        the other player.

        The server attaches the real player
        number instead of trusting the client.
      */

      broadcast(
        room,

        {
          type: "game",

          playerNumber:
            player.number,

          data:
            message.data
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

    if (
      message.type === "ping"
    ) {
      send(socket, {
        type: "pong"
      });

      return;
    }
  });

  /*
  ==================================================
  PLAYER DISCONNECT
  ==================================================
  */

  socket.on("close", () => {
    if (!roomId) {
      return;
    }

    const room =
      rooms.get(roomId);

    if (!room) {
      return;
    }

    room.players =
      room.players.filter(
        p =>
          p.socket !== socket
      );

    room.roundEndHandled = false;
    room.megumiPets = {};

    /*
      Tell the remaining player that their
      opponent disconnected.
    */

    broadcast(room, {
      type: "player-left"
    });

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

server.listen(
  PORT,
  () => {
    console.log(
      `Sorcery Brawl server running on port ${PORT}`
    );
  }
);
