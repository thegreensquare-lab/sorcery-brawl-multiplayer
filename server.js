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

/*
====================================================
UTILITY FUNCTIONS
====================================================
*/

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

  res.end(
    "Sorcery Brawl multiplayer server is online!"
  );
});

/*
====================================================
WEBSOCKET SERVER
====================================================
*/

const wss = new WebSocket.Server({
  server
});

/*
====================================================
CHARACTER SELECTION
====================================================
*/

function chooseShape(player) {
  if (
    !player ||
    !player.selectedShape
  ) {
    return null;
  }

  if (
    player.selectedShape === "random"
  ) {
    return randomFrom(SHAPES);
  }

  return player.selectedShape;
}

/*
====================================================
START MATCH
====================================================
*/

function startMatch(room) {
  if (
    !room ||
    room.players.length !== 2
  ) {
    return;
  }

  if (
    !room.players.every(
      player => player.ready
    )
  ) {
    return;
  }

  /*
    Make sure both players selected a valid
    character before starting.
  */

  if (
    !room.players.every(
      player =>
        SHAPES.includes(
          player.selectedShape
        ) ||
        player.selectedShape === "random"
    )
  ) {
    return;
  }

  const p1 = room.players.find(
    player => player.number === 1
  );

  const p2 = room.players.find(
    player => player.number === 2
  );

  if (!p1 || !p2) {
    return;
  }

  /*
    Resolve Random exactly once on the server.

    This means both computers receive the same
    character if either player selected Random.
  */

  p1.shape = chooseShape(p1);
  p2.shape = chooseShape(p2);

  room.roundEndHandled = false;

  broadcast(room, {
    type: "match-start",

    p1Shape: p1.shape,
    p2Shape: p2.shape,

    p1Random:
      p1.selectedShape === "random",

    p2Random:
      p2.selectedShape === "random"
  });
}

/*
====================================================
RESET FOR NEXT ROUND
====================================================
*/

function resetForNextRound(room) {
  if (
    !room ||
    room.players.length !== 2
  ) {
    return;
  }

  const p1 = room.players.find(
    player => player.number === 1
  );

  const p2 = room.players.find(
    player => player.number === 2
  );

  if (!p1 || !p2) {
    return;
  }

  /*
    Re-roll only players who originally
    selected Random.
  */

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

    /*
      Safely parse incoming JSON.
    */

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

    if (
      message.type === "join"
    ) {
      roomId = String(
        message.room || ""
      ).trim();

      if (!roomId) {
        return;
      }

      /*
        Create room if it doesn't exist.
      */

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          players: [],
          roundEndHandled: false,
          megumiPets: {}
        });
      }

      const room = rooms.get(roomId);

      /*
        Only two players are allowed.
      */

      if (
        room.players.length >= 2
      ) {
        send(socket, {
          type: "room-full"
        });

        return;
      }

      /*
        Create the player.

        Player number is assigned by the server,
        never trusted from the client.
      */

      player = {
        socket,

        number:
          room.players.length + 1,

        ready: false,

        /*
          Character selected in the character
          selection screen.

          This stays separate from the actual
          in-game character.
        */

        selectedShape: null,

        /*
          Actual character being used in
          the current round.
        */

        shape: null
      };

      room.players.push(player);

      /*
        Tell this player that they joined.
      */

      send(socket, {
        type: "joined",

        players:
          room.players.length,

        playerNumber:
          player.number
      });

      /*
        Tell Player 1 when Player 2 joins.
      */

      if (
        room.players.length === 2
      ) {
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

    if (
      !player ||
      !roomId
    ) {
      return;
    }

    const room =
      rooms.get(roomId);

    if (!room) {
      return;
    }

    /*
    ==================================================
    CHARACTER SELECTION
    ==================================================
    */

    if (
      message.type ===
      "select-character"
    ) {
      const shape = String(
        message.shape || ""
      ).toLowerCase();

      /*
        Only allow real characters or Random.
      */

      if (
        !SHAPES.includes(shape) &&
        shape !== "random"
      ) {
        return;
      }

      /*
        Don't allow changing character
        after Ready.
      */

      if (player.ready) {
        return;
      }

      /*
        Store this player's selection.

        Player 1 and Player 2 have completely
        separate selections.
      */

      player.selectedShape = shape;

      /*
        Do NOT resolve Random here.

        The server resolves Random when the
        match actually starts.
      */

      player.shape = null;

      send(socket, {
        type:
          "character-selected",

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
      message.type ===
      "ready"
    ) {
      /*
        A character must have been selected first.
      */

      if (
        !player.selectedShape
      ) {
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

      /*
        Tell this player their Ready state.
      */

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
        Tell the opponent.
      */

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
        If both players are ready,
        start the match.
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
        Send the same random result
        to both computers.
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

      /*
        Only Player 1 or Player 2 can win.
      */

      if (
        winnerNumber !== 1 &&
        winnerNumber !== 2
      ) {
        return;
      }

      /*
        Prevent duplicate round-end messages
        from counting the same round twice.
      */

      if (
        room.roundEndHandled
      ) {
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
      /*
        A next round can only happen after
        the server has accepted a round end.
      */

      if (
        !room.roundEndHandled ||
        room.players.length !== 2
      ) {
        return;
      }

      /*
        Clear old Megumi selections so the
        next round can choose a fresh Shikigami.
      */

      room.megumiPets = {};

      resetForNextRound(room);

      return;
    }

    /*
    ==================================================
    GAME EVENT RELAY
    ==================================================

    IMPORTANT:

    Combat damage is now sent as a GAME EVENT.

    Example from the client:

      {
        type: "game",
        data: {
          kind: "damage",
          targetPlayerNumber: 2,
          amount: 20,
          attackType: "cleave"
        }
      }

    The server does NOT modify the damage.

    It simply relays the event to the opponent
    and attaches the real player number.

    This prevents the old system where one player's
    health could be overwritten by the opponent's
    normal state synchronization.
    */

    if (
      message.type === "game"
    ) {
      if (
        !message.data ||
        typeof message.data !== "object"
      ) {
        return;
      }

      /*
        Only relay known game-event types.

        "damage" is the important new event.
        "state" is the normal position/state update.
      */

      const allowedKinds = [
        "damage",
        "state"
      ];

      /*
        Other game events are also allowed so the
        existing game remains compatible.

        If the client sends an unknown event,
        it is still treated as a normal game event.
      */

      const gameData = {
        ...message.data
      };

      /*
        For damage events, make sure the target
        is actually Player 1 or Player 2.

        This prevents malformed target numbers.
      */

      if (
        gameData.kind === "damage"
      ) {
        const targetPlayerNumber =
          Number(
            gameData.targetPlayerNumber
          );

        if (
          targetPlayerNumber !== 1 &&
          targetPlayerNumber !== 2
        ) {
          return;
        }

        /*
          The attacker cannot damage themselves.
        */

        if (
          targetPlayerNumber ===
          player.number
        ) {
          return;
        }

        /*
          Damage must be a finite positive number.
        */

        const amount =
          Number(gameData.amount);

        if (
          !Number.isFinite(amount) ||
          amount <= 0
        ) {
          return;
        }

        /*
          Replace the value with the sanitized
          numeric value.
        */

        gameData.amount = amount;
        gameData.targetPlayerNumber =
          targetPlayerNumber;
      }

      /*
        Send this player's game event ONLY
        to the opponent.

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
            gameData
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
      message.type ===
      "ping"
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

    /*
      Remove the disconnected player.
    */

    room.players =
      room.players.filter(
        p =>
          p.socket !== socket
      );

    /*
      Reset round-specific server state.
    */

    room.roundEndHandled = false;
    room.megumiPets = {};

    /*
      Tell the remaining player that their
      opponent disconnected.
    */

    broadcast(room, {
      type:
        "player-left"
    });

    /*
      Delete empty rooms.
    */

    if (
      room.players.length === 0
    ) {
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
