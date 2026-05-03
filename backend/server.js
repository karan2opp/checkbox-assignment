import express from "express";
import http from "http";
import Server  from "socket.io";
import crypto from "crypto";
import axios from "axios";
import session from "express-session";
import cors from "cors";
import dotenv from "dotenv";

import { redis, publisher, subscriber } from "./reddis-connection.js";

dotenv.config();

const CHECK_BOX_KEY = "state-v1";

async function main() {
  const app = express();
  const server = http.createServer(app);

  // ✅ CORS (FIXED)
  const allowedOrigins = process.env.FRONTEND_URLS.split(",");
   app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    })
  );
 

  // ✅ Session middleware (REQUIRED)
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    },
  })
);


  app.use(express.json());

  // ✅ Socket.IO (FIXED CORS)
  const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

  // ------------------ HEALTH ------------------
  app.get("/health", async (req, res) => {
    try {
      await redis.ping();
      res.json({ status: "ok" });
    } catch (err) {
      res.status(500).json({ status: "error" });
    }
  });

  // ------------------ STATE ------------------
  app.get("/state", async (req, res) => {
    try {
      const start = parseInt(req.query.start) || 0;
      const limit = parseInt(req.query.limit) || 100;

      const pipeline = redis.pipeline();

      for (let i = start; i < start + limit; i++) {
        pipeline.getbit(CHECK_BOX_KEY, i);
      }

      const results = await pipeline.exec();

      const data = results.map(([_, bit]) => bit === 1);

      res.json({ start, limit, data });
    } catch (err) {
      res.status(500).json({ error: "failed to fetch state" });
    }
  });

// ------------------ LOGIN ------------------
app.get("/auth/login", async (req, res) => {
  const CLIENT_ID = process.env.KAUTH_CLIENT_ID;
  const REDIRECT_URI = process.env.KAUTH_REDIRECT_URI;
  const KAUTH_URL = process.env.KAUTH_API_URL;

  if (!CLIENT_ID || !REDIRECT_URI || !KAUTH_URL) {
    return res.status(500).send("Missing env variables");
  }


  const state = crypto.randomBytes(16).toString("hex");

  await redis.set(`oauth_state:${state}`, "valid", "EX", 300); // 👈 store in Redis, expires in 5 min

  const url =
    `${KAUTH_URL}/api/oidc/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&redirect_uri=${REDIRECT_URI}` +
    `&response_type=code` +
    `&scope=openid profile email` +
    `&state=${state}`;
 console.log("KAUTH_URL:", KAUTH_URL); // 👈 add this
  console.log("redirecting to:", `${KAUTH_URL}/api/oidc/authorize`); 
  return res.redirect(url); // no session.save() needed anymore
});
app.get("/auth/register", (req, res) => {
  const CLIENT_ID = process.env.KAUTH_CLIENT_ID;
  const REDIRECT_URI = process.env.KAUTH_REDIRECT_URI;
  const KAUTH_URL = process.env.KAUTH_BASE_URL;

  if (!CLIENT_ID || !REDIRECT_URI || !KAUTH_URL) {
    return res.status(500).send("Missing env variables");
  }

  // redirect to KAuth frontend register page with OIDC params
  const url = `${KAUTH_URL}/register`
    + `?client_id=${CLIENT_ID}`
    + `&redirect_uri=${REDIRECT_URI}`
    + `&response_type=code`
    + `&scope=openid profile email`;

  return res.redirect(url);
});

// // ------------------ CALLBACK ------------------
app.get("/api/oidc/callback", async (req, res) => {
  const { code } = req.query;
  console.log("callback hit, code:", code);

  try {
    const tokenRes = await axios.post(
      `${process.env.KAUTH_BASE_URL}/api/oidc/token`,
      {
        code,
        client_id: process.env.KAUTH_CLIENT_ID,
        client_secret: process.env.KAUTH_CLIENT_SECRET,
        redirect_uri: process.env.KAUTH_REDIRECT_URI,
        grant_type: "authorization_code",
      }
    );

    console.log("token response:", tokenRes.data);

    const { accessToken } = tokenRes.data.data;

    const userInfoRes = await axios.get(
      `${process.env.KAUTH_BASE_URL}/api/oidc/userinfo`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    console.log("user info:", userInfoRes.data);

    req.session.user = userInfoRes.data.data;

    return res.redirect("https://checkbox.karanop.in");
  } catch (err) {
    console.error("callback error:", err.response?.data || err.message);
    return res.redirect("https://checkbox.karanop.in");
  }
});
// app.get("/api/oidc/callback", async (req, res) => {
//   const { code } = req.query;
//   console.log("callback hit, code:", code);
  
//   // TODO: exchange code for tokens properly
//   // For now just redirect to frontend
//   return res.redirect("https://checkbox.karanop.in");
// });
//   // ------------------ GET CURRENT USER ------------------
  app.get("/api/auth/me", (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ message: "Not logged in" });
    }

    res.json({ user: req.session.user });
  });

  // ------------------ LOGOUT ------------------
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ message: "Logged out" });
    });
  });

  // ------------------ REDIS PUB/SUB ------------------
  await subscriber.subscribe("checkbox_update");

  subscriber.on("message", (channel, message) => {
    if (channel === "checkbox_update") {
      const data = JSON.parse(message);
      io.emit("checkbox_update", data);
    }
  });

  // ------------------ SOCKET ------------------
  io.on("connection", (socket) => {
    socket.on("checkbox_update", async ({ index, checked }) => {
      const ip = socket.handshake.address;
      const key = `rate:${ip}`;

      const LIMIT = 2;
      const WINDOW = 5;

      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, WINDOW);
      }

      if (count > LIMIT) {
        socket.emit("rate_limited", {
          message: "Only 2 actions allowed every 5 seconds",
        });
        return;
      }

      await redis.setbit(CHECK_BOX_KEY, index, checked ? 1 : 0);

      await publisher.publish(
        "checkbox_update",
        JSON.stringify({ index, checked })
      );
    });
  });

  // ------------------ START SERVER ------------------
  const port = process.env.PORT || 8000;

  server.listen(port, () => {
    console.log(`Server running on ${port}`);
  });
}

main();