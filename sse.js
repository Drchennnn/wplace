// sse.js  —— 提供 SSE 路由和广播方法
import express from "express";

export const router = express.Router();
const clients = new Set();

/** 广播到所有连接的前端 */
export function sendToAll(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

/** 建立 SSE 连接：/api/events */
router.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders();
  res.write('event: hello\ndata: "connected"\n\n');
  clients.add(res);
  req.on("close", () => clients.delete(res));
});
