import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import ccxt from 'ccxt';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { evaluateStrategy, runBacktest, mapSymbol } from './strategyEngine.js';
import { saveTrade, getTrades, updateTrade, getStats } from './database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance();

const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'changeme';

const strategyConfig = {
    name: '3-Step NY Scalp Strategy',
    symbol: 'NAS100 / US100',
    timeframe: '5-Minute Chart',
    exchange: process.env.EXCHANGE || 'Not configured',
    steps: [
        'Step 1: Daily Bias via 7AM & 8AM EST 1H candle engulfing pattern',
        'Step 2: 15-Minute Opening Range Breakout (9:30-9:45 AM EST)',
        'Step 3: Breakout + POI pullback + engulfing entry trigger'
    ],
    riskReward: 'Dynamic ATR (2:1)'
};

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Trading Bot Backend is running' });
});

app.get('/api/status', async (req, res) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const trades = getTrades(1);
    const lastTrade = trades.length > 0 ? trades[0] : null;
    const stats = getStats();
    res.json({
        status: 'online',
        uptime: uptimeSeconds,
        uptimeFormatted: formatUptime(uptimeSeconds),
        totalSignals: getTrades().length,
        winRate: stats.winRate,
        wins: stats.wins,
        totalClosed: stats.total,
        lastSignalTime: lastTrade ? lastTrade.timestamp : null,
        lastSignalAction: lastTrade ? lastTrade.action : null,
        exchange: strategyConfig.exchange
    });
});

app.get('/api/trades', (req, res) => {
    res.json({ trades: getTrades(50) });
});

app.get('/api/config', (req, res) => {
    res.json(strategyConfig);
});

app.post('/api/webhook/tradingview', async (req, res) => {
    try {
        const payload = req.body;
        const secret = req.query.secret || req.headers['x-webhook-secret'];
        if (secret !== WEBHOOK_SECRET) {
            return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        }
        const trade = {
            symbol: payload.symbol || strategyConfig.symbol,
            action: (payload.action || payload.side || 'UNKNOWN').toUpperCase(),
            price: payload.price || payload.close || 0,
            stop: payload.stop || 0,
            target: payload.target || 0,
            source: 'WEBHOOK',
            reason: payload.strategy || strategyConfig.name
        };
        saveTrade(trade);
        res.status(200).json({ status: 'success', message: 'Webhook received' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Internal Server Error' });
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        const msg = String(message).toUpperCase();
        const knownSymbols = {
            'NAS100': 'FOREXCOM:NAS100', 'NDX': 'FOREXCOM:NAS100', 'US100': 'CAPITALCOM:US100',
            'SPX': 'TVC:SPX', 'EURUSD': 'OANDA:EURUSD', 'GBPUSD': 'OANDA:GBPUSD',
            'BTC': 'BINANCE:BTCUSD', 'ETH': 'BINANCE:ETHUSD', 'GOLD': 'OANDA:XAUUSD'
        };
        let targetSymbol = null;
        let tvSymbol = null;
        for (const [key, val] of Object.entries(knownSymbols)) {
            if (msg.includes(key)) {
                targetSymbol = key;
                tvSymbol = val;
                break;
            }
        }
        if (!targetSymbol) {
            return res.json({ reply: "Please mention a symbol (like NAS100) so I can run analysis." });
        }
        const result = await evaluateStrategy(targetSymbol);
        res.json({ reply: result.aiText, symbol: tvSymbol });
    } catch (e) {
        res.status(500).json({ reply: "An error occurred." });
    }
});

app.post('/api/general-chat', async (req, res) => {
    try {
        const { message } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) return res.json({ reply: "Add GEMINI_API_KEY to .env" });
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: "Trading assistant. Max 3 sentences: " + message }] }]
            })
        });
        const data = await response.json();
        const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
        res.json({ reply: replyText });
    } catch (e) {
        res.status(500).json({ reply: "Error." });
    }
});

app.post('/api/backtest', async (req, res) => {
    try {
        const { symbol, days } = req.body;
        const result = await runBacktest(symbol, days || 90);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: "Failed." });
    }
});

const watchList = [
    'FOREXCOM:NAS100', 'TVC:SPX', 'OANDA:EURUSD', 'OANDA:XAUUSD', 'BINANCE:BTCUSD'
];
setInterval(async () => {
    const existingTrades = getTrades(watchList.length * 2);
    for (const symbol of watchList) {
        const result = await evaluateStrategy(symbol);
        if (result && result.signal && result.signal.action !== 'NONE') {
            const recent = existingTrades.find(t => t.symbol === symbol && (Date.now() - new Date(t.timestamp).getTime()) < 3600000);
            if (!recent) {
                saveTrade({
                    symbol: symbol,
                    action: result.signal.action,
                    price: result.price,
                    stop: result.signal.stop,
                    target: result.signal.target,
                    source: 'AI',
                    reason: result.signal.reason
                });
            }
        }
    }
}, 60000);

app.get('/api/chart-data', async (req, res) => {
    try {
        const { symbol, days = 5 } = req.query;
        const yhSymbol = mapSymbol(symbol);
        const queryOptions = { period1: new Date(Date.now() - days * 24 * 60 * 60 * 1000), interval: '5m', includePrePost: true };
        const result = await yahooFinance.chart(yhSymbol, queryOptions);
        res.json({ quotes: result.quotes.filter(q => q.open !== null) });
    } catch (e) {\n        res.status(500).json({ error: e.message });
    }
});

app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
});

function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

app.listen(PORT, () => console.log('Server running'));
