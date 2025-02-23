require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const Redis = require("ioredis");
const cors = require("cors");

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

const redis = new Redis();
const CHAT_HISTORY_PREFIX = "chat:";
const chatRooms = new Map();

app.use(cors());
app.use(express.json());

wss.on("connection", (ws, req) => {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const placeId = params.get("placeId");

    if (!placeId) {
        console.error("❌ Invalid WebSocket Connection: Missing placeId");
        ws.close();
        return;
    }

    console.log(`🟢 New client connected to chat room: ${placeId}`);

    if (!chatRooms.has(placeId)) {
        chatRooms.set(placeId, new Set());
    }
    chatRooms.get(placeId).add(ws);

    broadcastUserCount(placeId);

    // ✅ Send previous chat messages (only once per connection)
    redis.lrange(`${CHAT_HISTORY_PREFIX}${placeId}`, 0, -1, (err, messages) => {
        if (!err && messages.length > 0) {
            ws.send(JSON.stringify({ type: "history", messages: messages.map(JSON.parse) }));
        }
    });

    ws.on("message", (message) => {
        try {
            const parsedMessage = JSON.parse(message);
            if (parsedMessage.type === "message") {
                const chatMessage = parsedMessage.chatMessage;
                chatMessage.timestamp = new Date().toISOString();

                console.log(`📩 New Chat Message:`, chatMessage);

                // ✅ Save to Redis
                redis.lpush(`${CHAT_HISTORY_PREFIX}${placeId}`, JSON.stringify(chatMessage));
                redis.ltrim(`${CHAT_HISTORY_PREFIX}${placeId}`, 0, 50);

                // ✅ Broadcast message ONLY ONCE to other users
                chatRooms.get(placeId).forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: "message", chatMessage }));
                    }
                });
            }
        } catch (error) {
            console.error("❌ Error processing chat message:", error);
        }
    });

    ws.on("close", () => {
        console.log(`🔴 Client disconnected from ${placeId}`);
        if (chatRooms.has(placeId)) {
            chatRooms.get(placeId).delete(ws);
            if (chatRooms.get(placeId).size === 0) {
                chatRooms.delete(placeId);
            }
            broadcastUserCount(placeId);
        }
    });
});

// ✅ Fix user count issue
const broadcastUserCount = (placeId) => {
    let count = chatRooms.has(placeId) ? chatRooms.get(placeId).size : 0;
    count = Math.ceil(count / 2); // Temporary fix for doubling issue

    console.log(`👥 Users in ${placeId}: ${count}`);

    chatRooms.get(placeId)?.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "user_count", count }));
        }
    });
};

// ✅ API to get chat history
app.get("/chat/history/:placeId", async (req, res) => {
    const { placeId } = req.params;
    const messages = await redis.lrange(`${CHAT_HISTORY_PREFIX}${placeId}`, 0, -1);
    res.json(messages.map(JSON.parse));
});

// ✅ Start WebSocket server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 WebSocket server running on ws://localhost:${PORT}/ws`));