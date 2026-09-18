const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("Sorcery Brawl multiplayer server is online!");
});

const wss = new WebSocket.Server({
  server
});

const rooms = new Map();

const SHAPES = [
  "circle",
  "square",
  "triangle",
  "rhombus",
  "star"
];

const PET_TYPES = [
  1, // Divine Dogs
  2, // Nue
  3  // Rabbit Escape
];

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function send(socket, message) {
  if (
    socket &&
    socket.readyState === WebSocket.OPEN
  ) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(room, message, except = null) {
  if (!room) return;

  for (const player of room.players) {
    if (player.socket === except) {
      continue;
    }

    send(player.socket, message);
  }
}

function broadcastToAll(room, message) {
  if (!room) return;

  for (const player of room.players) {
    send(player.socket, message);
  }
}

function getOpponent(room, player) {
  if (!room || !player) {
    return null;
  }

  return (
    room.players.find(
      (other) => other !== player
    ) || null
  );
}

function getRoomState(room) {
  if (!room) {
    return null;
  }

  return {
    players: room.players.map((player) => ({
      number: player.number,
      ready: player.ready,
      shape: player.shape,
      randomShape: player.randomShape
    }))
  };
}

function chooseRoundShapes(room) {
  if (!room || room.players.length !== 2) {
    return;
  }

  const p1 = room.players.find(
    (player) => player.number === 1
  );

  const p2 = room.players.find(
    (player) => player.number === 2
  );

  if (!p1 || !p2) {
    return;
  }

  /*
    IMPORTANT:

    Each player chooses their own character.

    If they chose Random, the SERVER chooses the
    character. This means both computers receive
    exactly the same character assignment.
  */

  if (p1.randomShape) {
    p1.shape = randomFrom(SHAPES);
  }

  if (p2.randomShape) {
    p2.shape = randomFrom(SHAPES);
  }
}

function startMatch(room) {
  if (!room) {
    return;
  }

  if (room.players.length !== 2) {
    return;
  }

  if (
    !room.players.every(
      (player) => player.ready
    )
  ) {
    return;
  }

  chooseRoundShapes(room);

  room.started = true;
  room.round = 1;

  broadcastToAll(room, {
    type: "match-start",

    p1Shape:
      room.players.find(
        (p) => p.number === 1
      )?.shape || null,

    p2Shape:
      room.players.find(
        (p) => p.number === 2
      )?.shape || null,

    p1Random:
      !!room.players.find(
        (p) => p.number === 1
      )?.randomShape,

    p2Random:
      !!room.players.find(
        (p) => p.number === 2
      )?.randomShape,

    round: room.round
  });
}

function resetForNextRound(room) {
  if (!room || room.players.length !== 2) {
    return;
  }

  chooseRoundShapes(room);

  room.round += 1;

  /*
    Players remain ready.

    Their scores are NOT stored here because the
    actual game client keeps its own score and
    reports the round result.

    The server's job is to synchronize the new
    character selections and round start.
  */

  broadcastToAll(room, {
    type: "round-reset",

    p1Shape:
      room.players.find(
        (p) => p.number === 1
      )?.shape || null,

    p2Shape:
      room.players.find(
        (p) => p.number === 2
      )?.shape || null,

    p1Random:
      !!room.players.find(
        (p) => p.number === 1
      )?.randomShape,

    p2Random:
      !!room.players.find(
        (p) => p.number === 2
      )?.randomShape,

    round: room.round
  });
}

function cleanupRoom(roomId, room) {
  if (!room) {
    return;
  }

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
      message = JSON.parse(
        raw.toString()
      );
    } catch (error) {
      return;
    }

    if (!message || typeof message !== "object") {
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
        send(socket, {
          type: "error",
          message: "A room code is required."
        });

        return;
      }

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          players: [],
          started: false,
          round: 0
        });
      }

      const room = rooms.get(roomId);

      if (room.players.length >= 2) {
        send(socket, {
          type: "room-full"
        });

        return;
      }

      /*
        Player number is determined by the order
        they join the room.
      */

      player = {
        socket,

        number:
          room.players.length + 1,

        ready: false,

        shape: null,

        randomShape: false
      };

      room.players.push(player);

      send(socket, {
        type: "joined",

        players:
          room.players.length,

        playerNumber:
          player.number
      });

      /*
        Tell the existing player that someone joined.
      */

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

      /*
        Send the current room state to the new player.
      */

      send(socket, {
        type: "room-state",

        state:
          getRoomState(room)
      });

      return;
    }

    /*
    ==================================================
    EVERYTHING BELOW REQUIRES A VALID ROOM
    ==================================================
    */

    if (!player || !roomId) {
      return;
    }

    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    /*
    ==================================================
    READY
    ==================================================
    */

    if (message.type === "ready") {
      let shape = String(
        message.shape || ""
      ).toLowerCase();

      /*
        Accept "random" as a special character.
      */

      if (
        shape !== "random" &&
        !SHAPES.includes(shape)
      ) {
        send(socket, {
          type: "error",
          message: "Invalid character."
        });

        return;
      }

      player.randomShape =
        shape === "random";

      player.shape =
        player.randomShape
          ? null
          : shape;

      player.ready = true;

      /*
        Tell this player whether their opponent
        is ready.
      */

      const opponent =
        getOpponent(room, player);

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

      /*
        Tell the opponent that this player is ready.
      */

      if (opponent) {
        send(opponent.socket, {
          type: "ready-state",

          playerNumber:
            player.number,

          ready: true,

          opponentReady: true
        });
      }

      /*
        Start only when BOTH players are ready.
      */

      if (
        room.players.length === 2 &&
        room.players.every(
          (p) => p.ready
        )
      ) {
        startMatch(room);
      }

      return;
    }

    /*
    ==================================================
    CANCEL READY
    ==================================================
    */

    if (
      message.type === "cancel-ready"
    ) {
      player.ready = false;

      send(socket, {
        type: "ready-state",

        playerNumber:
          player.number,

        ready: false,

        opponentReady:
          !!(
            getOpponent(room, player)
              ?.ready
          )
      });

      const opponent =
        getOpponent(room, player);

      if (opponent) {
        send(opponent.socket, {
          type: "ready-state",

          playerNumber:
            player.number,

          ready: false,

          opponentReady: false
        });
      }

      return;
    }

    /*
    ==================================================
    MEGUMI SHIKIGAMI REQUEST
    ==================================================

    The player asks the server for one random
    Shikigami.

    The server chooses it ONCE.

    Both computers receive the SAME result.
    */

    if (
      message.type ===
      "megumi-pet-request"
    ) {
      const requestedPlayerNumber =
        Number(
          message.playerNumber
        );

      if (
        requestedPlayerNumber !==
          1 &&
        requestedPlayerNumber !==
          2
      ) {
        return;
      }

      /*
        A player can only request a pet result
        for themselves.
      */

      if (
        requestedPlayerNumber !==
        player.number
      ) {
        return;
      }

      const petType =
        randomFrom(PET_TYPES);

      /*
        Remember the result in the room so that
        repeated requests during the same selection
        can return the same result.
      */

      if (!room.megumiPets) {
        room.megumiPets = {};
      }

      room.megumiPets[
        requestedPlayerNumber
      ] = petType;

      broadcastToAll(room, {
        type: "megumi-pet-type",

        playerNumber:
          requestedPlayerNumber,

        petType
      });

      return;
    }

    /*
    ==================================================
    MEGUMI PET REQUEST AGAIN
    ==================================================
    */

    if (
      message.type ===
      "megumi-pet-request-existing"
    ) {
      const requestedPlayerNumber =
        Number(
          message.playerNumber
        );

      if (
        requestedPlayerNumber !==
          1 &&
        requestedPlayerNumber !==
          2
      ) {
        return;
      }

      if (
        requestedPlayerNumber !==
        player.number
      ) {
        return;
      }

      if (!room.megumiPets) {
        room.megumiPets = {};
      }

      let petType =
        room.megumiPets[
          requestedPlayerNumber
        ];

      if (!PET_TYPES.includes(petType)) {
        petType =
          randomFrom(PET_TYPES);

        room.megumiPets[
          requestedPlayerNumber
        ] = petType;
      }

      broadcastToAll(room, {
        type: "megumi-pet-type",

        playerNumber:
          requestedPlayerNumber,

        petType
      });

      return;
    }

    /*
    ==================================================
    NEXT ROUND
    ==================================================
    */

    if (
      message.type === "next-round"
    ) {
      if (room.players.length !== 2) {
        return;
      }

      /*
        Only allow a player who actually belongs
        to the room to request the next round.
      */

      if (!player) {
        return;
      }

      /*
        Avoid starting another round while the
        players are not both ready.

        If the client sends next-round directly,
        we keep both players synchronized.
      */

      if (!room.players.every(
        (p) => p.ready
      )) {
        return;
      }

      /*
        Clear the old Megumi pet selections.
        A new Shikigami can therefore be chosen
        during the new round.
      */

      room.megumiPets = {};

      resetForNextRound(room);

      return;
    }

    /*
    ==================================================
    GAME STATE / INPUT RELAY
    ==================================================

    This is the important multiplayer section.

    A client sends its local game information.

    The server forwards it ONLY to the other
    computer.

    The sender does NOT receive its own state back.

    This prevents a player's own keyboard from
    controlling the opponent.
    */

    if (message.type === "game") {
      if (room.players.length !== 2) {
        return;
      }

      /*
        Never allow a client to claim it is another
        player.

        The server attaches the actual player number
        belonging to this socket.
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
    INPUT RELAY
    ==================================================

    Some versions of the client may send individual
    keyboard/input messages instead of full game
    state. Those are also forwarded.

    Again, the server assigns the real player number.
    */

    if (
      message.type === "input"
    ) {
      if (room.players.length !== 2) {
        return;
      }

      broadcast(
        room,

        {
          type: "input",

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
    ACTION RELAY
    ==================================================

    Used for attacks, abilities and supers when the
    client sends actions separately.
    */

    if (
      message.type === "action"
    ) {
      if (room.players.length !== 2) {
        return;
      }

      broadcast(
        room,

        {
          type: "action",

          playerNumber:
            player.number,

          action:
            message.action,

          data:
            message.data
        },

        socket
      );

      return;
    }

    /*
    ==================================================
    ROUND RESULT
    ==================================================

    The client can tell the other computer that a
    round ended.

    The server does NOT decide who won.

    It simply synchronizes the event.
    */

    if (
      message.type ===
      "round-result"
    ) {
      if (room.players.length !== 2) {
        return;
      }

      broadcast(
        room,

        {
          type: "round-result",

          playerNumber:
            player.number,

          winner:
            message.winner,

          loser:
            message.loser
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
  DISCONNECT
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

    /*
      Remove this player's socket.
    */

    room.players =
      room.players.filter(
        (p) =>
          p.socket !== socket
      );

    /*
      Reset the room if somebody leaves.
    */

    room.started = false;
    room.round = 0;
    room.megumiPets = {};

    /*
      Tell the remaining player.
    */

    broadcastToAll(room, {
      type: "player-left"
    });

    cleanupRoom(
      roomId,
      room
    );
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
