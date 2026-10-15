
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const rooms = new Map();

// Keep these IDs in sync with the character IDs used by the client.
const SHAPES = [
  "circle",   // Gojo
  "square",   // Choso
  "triangle", // Naoya
  "rhombus",  // Sukuna
  "star",     // Megumi
  "pentagon", // Hakari
  "plus",     // Yuta
  "x",        // Nobara
  "octagon",  // Todo / Yuji
  "trapezoid" // Jogo
];

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

function teamForNumber(number) {
  return number === 1 || number === 3 ? 1 : 2;
}

function teammateNumbers(number) {
  return number === 1 ? [3] :
    number === 3 ? [1] :
    number === 2 ? [4] : [2];
}

function roomCapacity(room) {
  return room && room.mode === "2v2" ? 4 : 2;
}

function roomPlayerSummary(room, viewerNumber = null) {
  const humans = room.players.filter(p => p.socket);

  return {
    mode: room.mode || "1v1",
    players: humans.length,
    capacity: roomCapacity(room),
    ready: humans.filter(p => p.ready).length,

    slots: [1, 2, 3, 4].map(number => {
      const p = room.players.find(x => x.number === number);

      if (!p) {
        return {
          number,
          teamId: teamForNumber(number),
          relation: "empty",
          ready: false,
          selectedShape: null,
          isBot: false
        };
      }

      let relation;

      if (room.mode === "2v2" && Number.isInteger(viewerNumber)) {
        relation = number === viewerNumber
          ? "you"
          : teamForNumber(number) === teamForNumber(viewerNumber)
            ? "teammates"
            : "opponent";
      } else if (room.mode === "2v2") {
        relation = "teammates";
      } else {
        relation = number === viewerNumber ? "you" : "opponent";
      }

      return {
        number,
        teamId: teamForNumber(number),
        relation,
        ready: !!p.ready,
        selectedShape: p.selectedShape,
        isBot: !p.socket
      };
    })
  };
}

function sendLobbyState(room) {
  if (!room) return;

  for (const player of room.players) {
    if (!player.socket) continue;

    send(player.socket, {
      type: "lobby-state",
      ...roomPlayerSummary(room, player.number)
    });
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("Sorcery Brawl multiplayer server is online!");
});

const wss = new WebSocket.Server({ server });

function chooseShape(player) {
  if (!player || !player.selectedShape) return null;

  if (player.selectedShape === "random") {
    const choices = SHAPES.filter(shape => shape !== player.shape);
    return randomFrom(choices.length ? choices : SHAPES);
  }

  return SHAPES.includes(player.selectedShape)
    ? player.selectedShape
    : null;
}

function defaultPosition(number) {
  const team = teamForNumber(number);

  return {
    x: team === 1 ? 150 : 810,
    y: number === 1 || number === 2 ? 190 : 410
  };
}

function check2v2RoundEnd(room) {
  if (
    !room ||
    room.mode !== "2v2" ||
    !room.matchStarted ||
    room.roundEndHandled
  ) return;

  const teamAlive = team => room.players.some(p =>
    p.teamId === team &&
    (p.state?.health ?? 100) > 0
  );

  const one = teamAlive(1);
  const two = teamAlive(2);

  if (one && two) return;

  room.roundEndHandled = true;

  broadcast(room, {
    type: "round-end",
    winnerNumber: one ? 1 : 2,
    winnerTeam: one ? 1 : 2,
    mode: "2v2"
  });
}

function startMatch(room) {
  if (!room) return;

  const capacity = roomCapacity(room);
  const humans = room.players.filter(p => p.socket);
  const botFill = room.mode === "2v2" && room.botFill === true;

  if ((!botFill && humans.length !== capacity) ||
      (botFill && humans.length < 1)) return;

  if (!humans.every(player => player.ready)) return;

  const required = room.mode === "2v2"
    ? [1, 2, 3, 4]
    : [1, 2];

  for (const number of required) {
    const player = room.players.find(p => p.number === number);

    if (!player) {
      if (botFill) continue;
      return;
    }

    if (!SHAPES.includes(player.selectedShape) &&
        player.selectedShape !== "random") {
      send(player.socket, {
        type: "error",
        message: `Your selected character (${player.selectedShape || "none"}) isn't supported by this server. Please select again.`
      });
      return;
    }
  }

  for (const player of room.players) {
    player.shape = chooseShape(player);
    player.state = {
      ...defaultPosition(player.number),
      health: 100
    };
    player.lastAttackAt = 0;
    player.teamId = teamForNumber(player.number);
  }

  room.matchStarted = true;
  room.roundEndHandled = false;
  room.botAuthorityNumber = botFill
    ? Math.min(...humans.map(p => p.number))
    : null;

  const players = required.map(number => {
    const player = room.players.find(p => p.number === number);

    return player
      ? {
          number,
          teamId: player.teamId,
          relation: player.socket ? player.relation : "bot",
          shape: player.shape,
          random: player.selectedShape === "random",
          isBot: !player.socket
        }
      : {
          number,
          teamId: teamForNumber(number),
          relation: "teammates",
          shape: randomFrom(SHAPES),
          random: true,
          isBot: true
        };
  });

  broadcast(room, {
    type: "match-start",
    mode: room.mode || "1v1",
    players,
    p1Shape: players[0]?.shape,
    p2Shape: players[1]?.shape,
    p1Random: !!players[0]?.random,
    p2Random: !!players[1]?.random,
    teams: {
      team1: [1, 3],
      team2: [2, 4]
    },
    botFill,
    botAuthorityNumber: room.botAuthorityNumber
  });

  // The designated game client is responsible for running bot AI.
}

function resetForNextRound(room) {
  if (!room) return;

  const required = room.mode === "2v2"
    ? [1, 2, 3, 4]
    : [1, 2];

  if (
    required.some(number =>
      !room.players.some(p => p.number === number)
    ) &&
    !room.botFill
  ) return;

  for (const player of room.players) {
    player.shape = chooseShape(player);
  }

  room.roundEndHandled = false;

  broadcast(room, {
    type: "round-reset",
    mode: room.mode || "1v1",
    players: required.map(number => {
      const p = room.players.find(x => x.number === number);

      return p
        ? {
            number,
            teamId: p.teamId,
            shape: p.shape,
            random: p.selectedShape === "random",
            isBot: !p.socket
          }
        : {
            number,
            teamId: teamForNumber(number),
            shape: randomFrom(SHAPES),
            random: true,
            isBot: true
          };
    }),
    p1Shape: room.players.find(p => p.number === 1)?.shape,
    p2Shape: room.players.find(p => p.number === 2)?.shape,
    p1Random: room.players.find(p => p.number === 1)?.selectedShape === "random",
    p2Random: room.players.find(p => p.number === 2)?.selectedShape === "random"
  });
}

wss.on("connection", socket => {
  let roomId = null;
  let player = null;

  socket.on("message", raw => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!message || typeof message !== "object") return;

    if (message.type === "join") {
      roomId = String(message.room || "").trim();

      if (!roomId) return;

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          players: [],
          id: roomId,
          mode: message.mode === "2v2" ? "2v2" : "1v1",
          botFill: false,
          matchStarted: false,
          roundEndHandled: false,
          megumiPets: {}
        });
      }

      const room = rooms.get(roomId);
      const requestedMode = message.mode === "2v2" ? "2v2" : "1v1";

      if (room.players.length === 0) {
        room.mode = requestedMode;
      }

      if (room.mode !== requestedMode) {
        send(socket, {
          type: "error",
          message: "This room was created for a different game mode."
        });
        return;
      }

      if (room.matchStarted) {
        send(socket, {
          type: "error",
          message: "This match has already started."
        });
        return;
      }

      const capacity = roomCapacity(room);

      if (room.players.filter(p => p.socket).length >= capacity) {
        send(socket, { type: "room-full" });
        return;
      }

      const occupied = new Set(room.players.map(p => p.number));
      const availableNumber = [1, 2, 3, 4]
        .slice(0, capacity)
        .find(n => !occupied.has(n));

      if (!availableNumber) {
        send(socket, { type: "room-full" });
        return;
      }

      player = {
        socket,
        number: availableNumber,
        teamId: teamForNumber(availableNumber),
        relation: room.mode === "2v2" ? "teammates" : "opponent",
        ready: false,
        selectedShape: null,
        shape: null
      };

      room.players.push(player);

      send(socket, {
        type: "joined",
        ...roomPlayerSummary(room, player.number),
        playerNumber: player.number,
        teamId: player.teamId,
        relation: room.mode === "2v2" ? "teammates" : "opponent",
        teammateNumbers: room.mode === "2v2"
          ? teammateNumbers(player.number)
          : [],
        teams: {
          team1: [1, 3],
          team2: [2, 4]
        }
      });

      broadcast(room, {
        type: "player-joined",
        ...roomPlayerSummary(room)
      }, socket);

      sendLobbyState(room);
      return;
    }

    if (!player || !roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (message.type === "start-with-bots" && room.mode === "2v2") {
      if (room.matchStarted) return;

      if (!player.selectedShape) {
        send(socket, {
          type: "error",
          message: "Choose a character before starting with bots."
        });
        return;
      }

      room.botFill = true;

      for (const human of room.players.filter(p => p.socket)) {
        if (!human.selectedShape) human.selectedShape = "random";
        human.ready = true;
      }

      for (const number of [1, 2, 3, 4]) {
        if (!room.players.some(p => p.number === number)) {
          room.players.push({
            socket: null,
            number,
            teamId: teamForNumber(number),
            relation: "teammates",
            ready: true,
            selectedShape: "random",
            shape: null,
            isBot: true
          });
        }
      }

      startMatch(room);
      return;
    }

    if (message.type === "select-position" && room.mode === "2v2") {
      const requested = Number(message.playerNumber);

      if (![1, 2, 3, 4].includes(requested)) return;

      if (room.players.some(p =>
        p !== player && p.number === requested
      )) {
        send(socket, {
          type: "position-taken",
          playerNumber: requested
        });
        return;
      }

      player.number = requested;
      player.teamId = teamForNumber(requested);
      player.relation = "teammates";
      player.ready = false;

      send(socket, {
        type: "position-selected",
        playerNumber: requested,
        teamId: player.teamId,
        relation: "teammates",
        teammateNumbers: teammateNumbers(requested)
      });

      sendLobbyState(room);
      return;
    }

    if (message.type === "select-character") {
      if (room.matchStarted || player.ready) return;

      const shape = String(message.shape || "").toLowerCase();

      if (!SHAPES.includes(shape) && shape !== "random") {
        send(socket, {
          type: "error",
          message: "Unsupported character selection."
        });
        return;
      }

      player.selectedShape = shape;
      player.shape = null;

      send(socket, {
        type: "character-selected",
        playerNumber: player.number,
        shape
      });

      sendLobbyState(room);
      return;
    }

    if (message.type === "ready") {
      if (room.matchStarted) return;

      if (!player.selectedShape) {
        send(socket, {
          type: "error",
          message: "Choose a character before Ready."
        });
        return;
      }

      player.ready = true;

      for (const recipient of room.players) {
        if (!recipient.socket) continue;

        const other = room.players.find(p =>
          p.socket && p !== recipient
        );

        send(recipient.socket, {
          type: "ready-state",
          playerNumber: player.number,
          ready: true,
          opponentReady: !!(other && other.ready),
          teamId: player.teamId,
          relation: room.mode === "2v2" ? "teammates" : "opponent",
          ...roomPlayerSummary(room, recipient.number)
        });
      }

      startMatch(room);
      sendLobbyState(room);
      return;
    }

    if (message.type === "cancel-ready") {
      if (room.matchStarted) return;

      player.ready = false;

      for (const recipient of room.players) {
        if (!recipient.socket) continue;

        const other = room.players.find(p =>
          p.socket && p !== recipient
        );

        send(recipient.socket, {
          type: "ready-state",
          playerNumber: player.number,
          ready: false,
          opponentReady: !!(other && other.ready),
          teamId: player.teamId,
          relation: room.mode === "2v2" ? "teammates" : "opponent",
          ...roomPlayerSummary(room, recipient.number)
        });
      }

      sendLobbyState(room);
      return;
    }

    if (message.type === "megumi-pet-request") {
      const targetNumber = Number(message.playerNumber);

      if (targetNumber !== player.number) return;

      const petType = randomFrom(PET_TYPES);
      room.megumiPets[targetNumber] = petType;

      broadcast(room, {
        type: "megumi-pet-type",
        playerNumber: targetNumber,
        petType
      });

      return;
    }

    if (message.type === "round-end") {
      const winnerNumber = Number(message.winnerNumber);

      if (room.mode === "2v2") {
        if (![1, 2, 3, 4].includes(winnerNumber)) return;
      } else if (winnerNumber !== 1 && winnerNumber !== 2) {
        return;
      }

      if (room.roundEndHandled) return;

      room.roundEndHandled = true;

      broadcast(room, {
        type: "round-end",
        winnerNumber,
        winnerTeam: room.mode === "2v2"
          ? teamForNumber(winnerNumber)
          : winnerNumber,
        mode: room.mode || "1v1"
      });

      return;
    }

    if (message.type === "next-round") {
      const requiredCount = roomCapacity(room);

      if (
        !room.roundEndHandled ||
        (!room.botFill &&
          room.players.filter(p => p.socket).length !== requiredCount)
      ) return;

      room.megumiPets = {};
      resetForNextRound(room);
      return;
    }

    if (message.type === "game") {
      if (!message.data || typeof message.data !== "object") {
        return;
      }

      if (!room.matchStarted) return;

      const gameData = { ...message.data };

      if (
        gameData.kind === "bot-state" &&
        room.mode === "2v2" &&
        room.botFill
      ) {
        if (
          player.number !== room.botAuthorityNumber ||
          !Array.isArray(gameData.players)
        ) return;

        const validBots = [];

        for (const state of gameData.players) {
          const number = Number(state.number);
          const bot = room.players.find(p =>
            p.number === number && !p.socket && p.isBot
          );

          if (
            !bot ||
            !Number.isFinite(state.x) ||
            !Number.isFinite(state.y) ||
            !Number.isFinite(state.health)
          ) continue;

          bot.state ||= {
            ...defaultPosition(number),
            health: 100
          };

          bot.state.x = Math.max(0, Math.min(960, state.x));
          bot.state.y = Math.max(0, Math.min(600, state.y));
          bot.state.health = Math.max(0, Math.min(500, state.health));

          if (SHAPES.includes(state.shape)) {
            bot.shape = state.shape;
          }

          validBots.push({
            number,
            teamId: bot.teamId,
            x: bot.state.x,
            y: bot.state.y,
            health: bot.state.health,
            maxHealth: state.maxHealth,
            shape: bot.shape,
            isBot: true
          });
        }

        if (validBots.length) {
          broadcast(room, {
            type: "bot-state",
            players: validBots
          }, socket);
        }

        check2v2RoundEnd(room);
        return;
      }

      if (
        gameData.kind === "state" &&
        Number.isFinite(gameData.x) &&
        Number.isFinite(gameData.y)
      ) {
        player.state ||= {
          ...defaultPosition(player.number),
          health: 100
        };

        player.state.x = Math.max(0, Math.min(960, gameData.x));
        player.state.y = Math.max(0, Math.min(600, gameData.y));

        if (Number.isFinite(gameData.health)) {
          player.state.health = Math.max(0, gameData.health);
        }

        check2v2RoundEnd(room);
      }

      if (gameData.kind === "damage") {
        const targetPlayerNumber = Number(gameData.targetPlayerNumber);

        if (![1, 2, 3, 4].includes(targetPlayerNumber)) return;

        const targetPlayer = room.players.find(p =>
          p.number === targetPlayerNumber
        );

        if (!targetPlayer) return;

        const sourceNumber = Number(
          gameData.sourcePlayerNumber || player.number
        );

        let sourceTeam = player.teamId;

        if (sourceNumber !== player.number) {
          const source = room.players.find(p =>
            p.number === sourceNumber
          );

          if (!(
            room.mode === "2v2" &&
            room.botFill &&
            player.number === room.botAuthorityNumber &&
            source &&
            !source.socket &&
            source.isBot
          )) return;

          sourceTeam = source.teamId;
        }

        if (targetPlayerNumber === sourceNumber) return;

        if (
          room.mode === "2v2" &&
          teamForNumber(targetPlayerNumber) === sourceTeam
        ) return;

        const amount = Number(gameData.amount);

        if (!Number.isFinite(amount) || amount <= 0) {
          return;
        }

        gameData.amount = amount;
        gameData.targetPlayerNumber = targetPlayerNumber;

        if (
          room.mode === "2v2" &&
          !targetPlayer.socket &&
          targetPlayer.isBot
        ) {
          targetPlayer.state ||= {
            ...defaultPosition(targetPlayerNumber),
            health: 100
          };

          if (sourceNumber !== player.number) {
            return;
          }

          targetPlayer.state.health = Math.max(
            0,
            targetPlayer.state.health - amount
          );

          broadcast(room, {
            type: "bot-state",
            players: [{
              number: targetPlayer.number,
              teamId: targetPlayer.teamId,
              x: targetPlayer.state.x,
              y: targetPlayer.state.y,
              health: targetPlayer.state.health,
              shape: targetPlayer.shape
            }]
          });

          check2v2RoundEnd(room);
          return;
        }
      }

      broadcast(room, {
        type: "game",
        playerNumber: player.number,
        teamId: player.teamId,
        relation: room.mode === "2v2" ? "teammates" : "opponent",
        data: gameData
      }, socket);

      return;
    }

    if (message.type === "ping") {
      send(socket, { type: "pong" });
    }
  });

  socket.on("close", () => {
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.players = room.players.filter(p => p.socket !== socket);
    room.roundEndHandled = false;
    room.matchStarted = false;
    room.megumiPets = {};

    for (const remaining of room.players) {
      remaining.ready = false;
    }

    broadcast(room, {
      type: "player-left",
      playerNumber: player ? player.number : null,
      ...roomPlayerSummary(room)
    });

    sendLobbyState(room);

    if (!room.players.some(p => p.socket)) {
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sorcery Brawl server running on port ${PORT}`);
});
