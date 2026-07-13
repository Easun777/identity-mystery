#!/bin/bash
# 犯人在跳舞 - 一键启动脚本
# 用法: bash start.sh

echo "🃏 启动游戏服务器..."
cd /D1/14yiyang/card_game
node server.js &
SERVER_PID=$!
sleep 1

echo "🌐 启动公网隧道..."
npx localtunnel --port 3000 &
TUNNEL_PID=$!

echo ""
echo "================================="
echo "  等待隧道地址出现..."
echo "  本地: http://localhost:3000/online.html"
echo "================================="

# 清理函数
cleanup() {
    echo ""
    echo "🛑 正在关闭..."
    kill $SERVER_PID 2>/dev/null
    kill $TUNNEL_PID 2>/dev/null
    exit
}
trap cleanup INT TERM

# 等待
wait
