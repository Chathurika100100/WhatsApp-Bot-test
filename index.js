import 'dotenv/config'; 
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import http from 'http'; 
import axios from 'axios'; 
import NodeCache from 'node-cache';
import * as cheerio from 'cheerio';

// 🌐 Web Server for Railway
const server = http.createServer((req, res) => {
    res.end('RV Games Ultra Bot is Online!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Web server is running on port ${PORT}`);
});

const authFolder = './bot_session';
const activeTasks = new Map(); 
const msgRetryCounterCache = new NodeCache();

// 🎮 FitGirl Session Storage
const fitgirlSessions = new Map();

// 📂 Session ID Setup
function setupSession() {
    const credsPath = path.join(authFolder, 'creds.json');
    if (fs.existsSync(credsPath)) return console.log("📂 පැරණි සෙෂන් දත්ත සොයාගන්නා ලදී...");

    const sessionId = process.env.SESSION_ID;
    if (!sessionId) {
        console.error("❌ ERROR: Railway Variables වල SESSION_ID එක දමා නැත!");
        process.exit(1);
    }

    fs.mkdirSync(authFolder, { recursive: true });
    try {
        let base64String = sessionId;
        if (sessionId.includes(';;;')) base64String = sessionId.split(';;;').pop();
        else if (sessionId.includes('~')) base64String = sessionId.split('~').pop();
        else if (sessionId.includes(':')) base64String = sessionId.split(':').pop();

        const decrypted = Buffer.from(base64String, 'base64').toString('utf-8');
        JSON.parse(decrypted); 
        fs.writeFileSync(credsPath, decrypted);
        console.log("✅ SESSION_ID එක සාර්ථකව ක්‍රියාත්මක කරන ලදී!");
    } catch (err) {
        console.error("❌ ERROR: SESSION_ID එකේ දෝෂයක් පවතී!");
        process.exit(1); 
    }
}
setupSession();

// 📊 Progress Bar 
function getProgressBar(percent) {
    const total = 10;
    const filled = Math.round((percent / 100) * total);
    const empty = total - filled;
    return '▰'.repeat(filled) + '▱'.repeat(empty);
}

// 🗂️ Extension Generator
function getExtensionFromMime(mimeType) {
    const map = {
        'application/zip': '.zip',
        'application/x-zip-compressed': '.zip',
        'application/x-rar-compressed': '.rar',
        'application/vnd.rar': '.rar',
        'application/x-rar': '.rar',
        'application/pdf': '.pdf',
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'video/mp4': '.mp4',
        'audio/mpeg': '.mp3',
        'application/vnd.android.package-archive': '.apk',
        'text/plain': '.txt',
        'application/octet-stream': '.bin'
    };
    return map[mimeType] || '.bin';
}

// ═══════════════════════════════════════════════════════════════
// 🔗 LINK RESOLVER - Multi-Host Support
// ═══════════════════════════════════════════════════════════════

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
};

// 🎯 FuckingFast Resolver
async function resolveFuckingFast(url) {
    try {
        console.log(`[RESOLVER] Resolving FuckingFast: ${url}`);

        const response = await axios.get(url, {
            headers: {
                ...BROWSER_HEADERS,
                'Referer': 'https://fitgirl-repacks.site/'
            },
            timeout: 20000,
            maxRedirects: 5,
            validateStatus: () => true
        });

        if (response.status !== 200) {
            console.log(`[RESOLVER] FuckingFast returned status ${response.status}`);
            return null;
        }

        const html = response.data;

        // Method 1: window.open pattern
        const dlMatch = html.match(/window\.open\("(https:\/\/dl\.fuckingfast\.co\/[^"]+)"/);
        if (dlMatch && dlMatch[1]) {
            console.log(`[RESOLVER] Found direct link (method 1): ${dlMatch[1]}`);
            return dlMatch[1];
        }

        // Method 2: Any dl.fuckingfast.co URL
        const altMatch = html.match(/(https:\/\/dl\.fuckingfast\.co\/[^"'\s]+)/);
        if (altMatch && altMatch[1]) {
            console.log(`[RESOLVER] Found direct link (method 2): ${altMatch[1]}`);
            return altMatch[1];
        }

        // Method 3: Look for download button onclick
        const onclickMatch = html.match(/onclick=["'].*?(https:\/\/dl\.fuckingfast\.co\/[^"']+)["']/);
        if (onclickMatch && onclickMatch[1]) {
            console.log(`[RESOLVER] Found direct link (method 3): ${onclickMatch[1]}`);
            return onclickMatch[1];
        }

        console.log(`[RESOLVER] Could not find direct link in FuckingFast page`);
        return null;
    } catch (error) {
        console.error(`[RESOLVER] FuckingFast error: ${error.message}`);
        return null;
    }
}

// 🎯 PixelDrain Resolver
async function resolvePixelDrain(url) {
    try {
        const fileId = url.match(/pixeldrain\.com\/\w+\/(\w+)/)?.[1];
        if (!fileId) return null;

        const apiUrl = `https://pixeldrain.com/api/file/${fileId}?download`;
        console.log(`[RESOLVER] PixelDrain direct: ${apiUrl}`);
        return apiUrl;
    } catch (error) {
        console.error(`[RESOLVER] PixelDrain error: ${error.message}`);
        return null;
    }
}

// 🎯 GoFile Resolver
async function resolveGoFile(url) {
    try {
        const contentId = url.match(/gofile\.io\/d\/(\w+)/)?.[1];
        if (!contentId) return null;

        // Get server and direct links via API
        const apiUrl = `https://api.gofile.io/contents/${contentId}?wt=4fd6s89d7s6`;
        const response = await axios.get(apiUrl, {
            headers: BROWSER_HEADERS,
            timeout: 15000
        });

        if (response.data?.data?.children) {
            const files = Object.values(response.data.data.children);
            if (files.length > 0) {
                console.log(`[RESOLVER] GoFile direct: ${files[0].link}`);
                return files[0].link;
            }
        }
        return null;
    } catch (error) {
        console.error(`[RESOLVER] GoFile error: ${error.message}`);
        return null;
    }
}

// 🎯 DataNodes Resolver
async function resolveDataNodes(url) {
    try {
        const response = await axios.get(url, {
            headers: { ...BROWSER_HEADERS, 'Referer': 'https://fitgirl-repacks.site/' },
            timeout: 15000,
            validateStatus: () => true
        });

        if (response.status === 200) {
            const html = response.data;
            // Try to find direct download link
            const directMatch = html.match(/href=["'](https:\/\/[^"']+)["'].*?download/i);
            if (directMatch) return directMatch[1];
        }

        // Fallback: return URL as-is, let axios handle redirects
        return url;
    } catch (error) {
        console.error(`[RESOLVER] DataNodes error: ${error.message}`);
        return url;
    }
}

// 🎯 BuzzHeavier Resolver
async function resolveBuzzHeavier(url) {
    try {
        const fileId = url.match(/buzzheavier\.com\/([^\/]+)/)?.[1];
        if (!fileId) return null;

        const directUrl = `https://buzzheavier.com/${fileId}/download`;
        console.log(`[RESOLVER] BuzzHeavier direct: ${directUrl}`);
        return directUrl;
    } catch (error) {
        console.error(`[RESOLVER] BuzzHeavier error: ${error.message}`);
        return null;
    }
}

// 🎯 Master Resolver - Detects host and routes to correct resolver
async function resolveDirectLink(url) {
    console.log(`[RESOLVER] Resolving: ${url}`);

    if (url.includes('fuckingfast.co')) {
        return await resolveFuckingFast(url);
    } else if (url.includes('pixeldrain.com')) {
        return await resolvePixelDrain(url);
    } else if (url.includes('gofile.io')) {
        return await resolveGoFile(url);
    } else if (url.includes('datanodes.to')) {
        return await resolveDataNodes(url);
    } else if (url.includes('buzzheavier.com')) {
        return await resolveBuzzHeavier(url);
    } else {
        // Unknown host - try to use as-is
        console.log(`[RESOLVER] Unknown host, using URL as-is`);
        return url;
    }
}

// ═══════════════════════════════════════════════════════════════
// 📥 DOWNLOADER
// ═══════════════════════════════════════════════════════════════

async function handleDownloadAndUpload(url, sock, msg, sendToJid, fileNameOverride = null) {
    const chatJid = msg.key.remoteJid;
    const progressMsg = await sock.sendMessage(chatJid, { text: `🔍 𝖱𝖵 𝖦𝖺𝗆𝖾𝗌 Bot ලින්ක් එක පරීක්ෂා කරමින් පවතී...` }, { quoted: msg });

    const controller = new AbortController();
    activeTasks.set(chatJid, {
        controller,
        progressMsgKey: progressMsg.key,
        uploadInterval: null,
        tempFilePath: null,
        writer: null,
        stream: null 
    });

    let tempFilePath = '';

    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            signal: controller.signal, 
            headers: BROWSER_HEADERS,
            maxRedirects: 10,
            timeout: 300000
        });

        if (activeTasks.has(chatJid)) {
            activeTasks.get(chatJid).stream = response.data;
        }

        let fileName = fileNameOverride || '';
        const contentDisposition = response.headers['content-disposition'];
        const contentType = response.headers['content-type'] || 'application/octet-stream';

        if (!fileName && contentDisposition) {
            const utf8Match = contentDisposition.match(/filename\*=\s*UTF-8''([^;\r\n]*)/i);
            if (utf8Match && utf8Match[1]) {
                fileName = decodeURIComponent(utf8Match[1]);
            } else {
                const normalMatch = contentDisposition.match(/filename\s*=\s*["']?([^;\r\n"']*)["']?/i);
                if (normalMatch && normalMatch[1]) {
                    fileName = normalMatch[1];
                }
            }
        }

        if (!fileName) {
            try {
                const urlParts = url.split('/');
                const lastPart = urlParts[urlParts.length - 1];
                const cleanName = lastPart.split('?')[0].split('#')[0];
                if (cleanName && cleanName.includes('.')) {
                    fileName = decodeURIComponent(cleanName);
                }
            } catch (e) {
                console.log("URL එකෙන් නම ගන්න බැරි වුණා.");
            }
        }

        if (fileName) {
            fileName = fileName.replace(/[/\\?%*:|"<>]/g, '-').trim(); 
        }

        if (!fileName || fileName.length > 200) {
            fileName = `RV_Games_File_${Math.floor(Math.random() * 10000)}`;
        }

        if (!fileName.includes('.')) {
            const ext = getExtensionFromMime(contentType);
            fileName += ext;
        }

        const totalLength = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedLength = 0;
        let lastUpdateTime = Date.now();

        tempFilePath = path.join('./', `${Date.now()}_${fileName}`);
        const writer = fs.createWriteStream(tempFilePath);

        if (activeTasks.has(chatJid)) {
            const task = activeTasks.get(chatJid);
            task.tempFilePath = tempFilePath;
            task.writer = writer;
        }

        response.data.on('data', async (chunk) => {
            if (controller.signal.aborted) return;

            downloadedLength += chunk.length;
            const now = Date.now();
            if (now - lastUpdateTime > 2000) { 
                lastUpdateTime = now;

                if (controller.signal.aborted) return; 

                const dlMB = (downloadedLength / (1024 * 1024)).toFixed(1);

                if (totalLength) {
                    const percent = ((downloadedLength / totalLength) * 100).toFixed(1);
                    const totMB = (totalLength / (1024 * 1024)).toFixed(1);
                    const bar = getProgressBar(percent);
                    const text = `📥 *Downloading:* ${fileName}\n📊 ${bar} ${percent}%\n📦 ${dlMB}MB / ${totMB}MB`;
                    await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
                } else {
                    const text = `📥 *Downloading:* ${fileName}\n📦 Downloaded: ${dlMB}MB (Size Unknown)`;
                    await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
                }
            }
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
            controller.signal.addEventListener('abort', () => {
                writer.destroy();
                reject(new Error('STOPPED'));
            });
        });

        let uploadPercent = 0;
        const totalMB = totalLength ? (totalLength / (1024 * 1024)).toFixed(1) : (downloadedLength / (1024 * 1024)).toFixed(1);

        const uploadInterval = setInterval(async () => {
            if (controller.signal.aborted) {
                clearInterval(uploadInterval);
                return;
            }
            if (uploadPercent < 90) {
                uploadPercent += Math.floor(Math.random() * 12) + 6; 
                if (uploadPercent > 94) uploadPercent = 94;
                const upMB = ((uploadPercent / 100) * totalMB).toFixed(1);
                const bar = getProgressBar(uploadPercent);
                const text = `📤 *Uploading:* ${fileName}\n📊 ${bar} ${uploadPercent.toFixed(1)}%\n📦 ${upMB}MB / ${totalMB}MB`;
                await sock.sendMessage(chatJid, { text: text, edit: progressMsg.key }).catch(() => {});
            }
        }, 1500);

        if (activeTasks.has(chatJid)) {
            activeTasks.get(chatJid).uploadInterval = uploadInterval;
        }

        await sock.sendMessage(sendToJid, { 
            document: { url: tempFilePath }, 
            mimetype: contentType, 
            fileName: fileName,
            caption: `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`
        });

        clearInterval(uploadInterval);
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); 
        activeTasks.delete(chatJid);

        await sock.sendMessage(chatJid, { text: `🎉 *${fileName}* සාර්ථකව යවන ලදී!\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`, edit: progressMsg.key }).catch(() => {});
        return true; 

    } catch (error) {
        const task = activeTasks.get(chatJid);
        if (task) {
            if (task.uploadInterval) clearInterval(task.uploadInterval);
            if (task.writer) { try { task.writer.destroy(); } catch(e){} }
            if (task.stream) { try { task.stream.destroy(); } catch(e){} }
        }
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) {}
        }

        if (axios.isCancel(error) || error.message === 'STOPPED' || controller.signal.aborted) {
            activeTasks.delete(chatJid);
            return 'STOPPED'; 
        }

        console.error(`[DOWNLOAD ERROR] ${error.message}`);
        activeTasks.delete(chatJid);
        await sock.sendMessage(chatJid, { text: `❌ දෝෂයක්: ${error.message}`, edit: progressMsg.key }).catch(() => {});
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
// 🎮 FITGIRL SCRAPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function searchFitGirl(gameName) {
    try {
        const searchUrl = `https://fitgirl-repacks.site/?s=${encodeURIComponent(gameName)}`;
        console.log(`[SCRAPER] Searching: ${searchUrl}`);

        const response = await axios.get(searchUrl, {
            headers: BROWSER_HEADERS,
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const results = [];

        $('article.type-post').each((i, el) => {
            const titleEl = $(el).find('h1.entry-title a, h2.entry-title a').first();
            const title = titleEl.text().trim();
            const link = titleEl.attr('href');
            const excerpt = $(el).find('.entry-summary p').first().text().trim().substring(0, 200);

            if (title && link) {
                results.push({
                    number: i + 1,
                    title,
                    link,
                    excerpt: excerpt || 'No description available'
                });
            }
        });

        console.log(`[SCRAPER] Found ${results.length} results`);
        return results;
    } catch (error) {
        console.error('[SCRAPER] Search Error:', error.message);
        return [];
    }
}

async function getFitGirlLinks(gameUrl) {
    try {
        console.log(`[SCRAPER] Fetching game page: ${gameUrl}`);

        const response = await axios.get(gameUrl, {
            headers: BROWSER_HEADERS,
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const links = [];

        // Priority 1: FuckingFast
        $('a[href*="fuckingfast.co"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('#')) {
                const fileName = href.split('#').pop();
                links.push({ host: 'fuckingfast', url: href, fileName });
            }
        });

        // Priority 2: PixelDrain
        $('a[href*="pixeldrain.com"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                const fileName = href.split('/').pop() || `part${links.length + 1}`;
                links.push({ host: 'pixeldrain', url: href, fileName });
            }
        });

        // Priority 3: GoFile
        $('a[href*="gofile.io"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                links.push({ host: 'gofile', url: href, fileName: `part${links.length + 1}` });
            }
        });

        // Priority 4: DataNodes
        $('a[href*="datanodes.to"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                links.push({ host: 'datanodes', url: href, fileName: `part${links.length + 1}` });
            }
        });

        // Priority 5: BuzzHeavier
        $('a[href*="buzzheavier.com"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                links.push({ host: 'buzzheavier', url: href, fileName: `part${links.length + 1}` });
            }
        });

        // Pastebin links
        $('a[href*="paste.fitgirl-repacks.site"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                links.push({ host: 'pastebin', url: href, fileName: 'pastebin_links' });
            }
        });

        console.log(`[SCRAPER] Found ${links.length} links from game page`);
        return links;
    } catch (error) {
        console.error('[SCRAPER] Links Error:', error.message);
        return [];
    }
}

async function getPastebinLinks(pasteUrl) {
    try {
        console.log(`[SCRAPER] Fetching pastebin: ${pasteUrl}`);

        const response = await axios.get(pasteUrl, {
            headers: BROWSER_HEADERS,
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const links = [];

        const hostPatterns = [
            { pattern: 'fuckingfast.co', host: 'fuckingfast' },
            { pattern: 'pixeldrain.com', host: 'pixeldrain' },
            { pattern: 'gofile.io', host: 'gofile' },
            { pattern: 'datanodes.to', host: 'datanodes' },
            { pattern: 'buzzheavier.com', host: 'buzzheavier' }
        ];

        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (!href) return;

            for (const hp of hostPatterns) {
                if (href.includes(hp.pattern)) {
                    let fileName = 'unknown';
                    if (href.includes('#')) {
                        fileName = href.split('#').pop();
                    } else {
                        fileName = href.split('/').pop() || `part${links.length + 1}`;
                    }

                    // Avoid duplicates
                    if (!links.some(l => l.url === href)) {
                        links.push({ host: hp.host, url: href, fileName });
                    }
                    break;
                }
            }
        });

        console.log(`[SCRAPER] Found ${links.length} links from pastebin`);
        return links;
    } catch (error) {
        console.error('[SCRAPER] Pastebin Error:', error.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════
// 🤖 BOT MAIN
// ═══════════════════════════════════════════════════════════════

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion(); 

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), 
        browser: ['RV Games Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        msgRetryCounterCache
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return; 

        let text = '';
        if (msg.message.conversation) {
            text = msg.message.conversation;
        } else if (msg.message.extendedTextMessage) {
            text = msg.message.extendedTextMessage.text || '';
        } else if (msg.message.imageMessage) {
            text = msg.message.imageMessage.caption || '';
        } else if (msg.message.videoMessage) {
            text = msg.message.videoMessage.caption || '';
        }

        text = text.trim();

        const isReplyToBot = msg.message.extendedTextMessage?.contextInfo?.stanzaId !== undefined;
        const session = fitgirlSessions.get(msg.key.remoteJid);
        const isNumberOnly = /^\d+$/.test(text);

        console.log(`[MESSAGE] From: ${msg.key.remoteJid}, Text: "${text}", IsReply: ${isReplyToBot}`);

        if (isNumberOnly && session && session.results && isReplyToBot) {
            text = `.fg ${text}`;
            console.log(`[AUTO CONVERT] Converted to: "${text}"`);
        }

        if (!text.startsWith('.')) return; 

        const senderJid = msg.key.participant || msg.key.remoteJid || ""; 
        const chatJid = msg.key.remoteJid;

        // 🔒 SECURITY CHECK
        const allowedNumbers = ['94701030330', '94740375946', '212038592811214', '275698514133039']; 
        const senderNumber = senderJid.split('@')[0].split(':')[0]; 

        console.log(`[SECURITY CHECK] Command from: ${senderNumber}`);

        if (!allowedNumbers.includes(senderNumber)) {
            const privateMessage = 
                `🔒 *𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙿𝚁𝙸𝚅𝙰𝚃𝙴 𝚂𝚈𝚂𝚃𝙴𝙼*\n\n` +
                `❌ *Sorry, Access Denied!*\n` +
                `ඔබට මෙම බොට්ගේ විධාන (Commands) භාවිතා කිරීමට අවසර නැත.\n\n` +
                `_This bot is restricted to authorized users only._\n\n` +
                `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

            return await sock.sendMessage(chatJid, { text: privateMessage }, { quoted: msg });
        }

        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = text.match(urlRegex) || [];

        // ═══════════════════════════════════════════════════════
        // 🎮 .fg [game name] - Search
        // ═══════════════════════════════════════════════════════
        if (text.startsWith('.fg ') && !text.match(/^\.fg\s+\d+$/)) {
            const gameName = text.replace('.fg ', '').trim();
            if (!gameName) {
                return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර game එකේ නම සඳහන් කරන්න.\nඋදා: `.fg Far Cry 3`' }, { quoted: msg });
            }

            const searchMsg = await sock.sendMessage(chatJid, { text: `🔍 FitGirl Repacks වල '${gameName}' සොයමින් පවතී...` }, { quoted: msg });

            try {
                const results = await searchFitGirl(gameName);

                if (results.length === 0) {
                    return await sock.sendMessage(chatJid, { text: `❌ '${gameName}' සඳහා results සොයාගත නොහැකි විය.`, edit: searchMsg.key });
                }

                let resultsText = `*🎮 FitGirl Repacks Search Results*\n\n`;
                resultsText += `*Query:* ${gameName}\n`;
                resultsText += `*Found:* ${results.length} game(s)\n\n`;
                resultsText += `*Reply with the number to get download links:*\n\n`;

                results.forEach((r, i) => {
                    resultsText += `${i + 1}. *${r.title}*\n`;
                    if (r.excerpt) resultsText += `   _${r.excerpt}_\n`;
                    resultsText += `\n`;
                });

                resultsText += `\n*Reply example:* \`1\` හෝ \`.fg 1\`\n\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*`;

                fitgirlSessions.set(chatJid, {
                    gameName,
                    results,
                    links: [],
                    timestamp: Date.now()
                });

                await sock.sendMessage(chatJid, { text: resultsText, edit: searchMsg.key });

            } catch (error) {
                console.error('.fg search error:', error);
                await sock.sendMessage(chatJid, { text: `❌ Search කිරීමේදී දෝෂයක්: ${error.message}`, edit: searchMsg.key });
            }
        }

        // 🎮 .fg [number] - Select result
        else if (text.match(/^\.fg\s+\d+$/)) {
            const selectedNum = parseInt(text.replace('.fg ', '').trim());
            const session = fitgirlSessions.get(chatJid);

            if (!session || !session.results || session.results.length === 0) {
                return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර පළමුව `.fg [game name]` භාවිතා කර search කරන්න.' }, { quoted: msg });
            }

            const selectedGame = session.results.find(r => r.number === selectedNum);
            if (!selectedGame) {
                return await sock.sendMessage(chatJid, { text: `❌ අංක ${selectedNum} සඳහා result එකක් නැත.` }, { quoted: msg });
            }

            const linkMsg = await sock.sendMessage(chatJid, { text: `📋 *${selectedGame.title}* වෙතින් links ලබා ගනිමින්...` }, { quoted: msg });

            try {
                let allLinks = [];
                const pageLinks = await getFitGirlLinks(selectedGame.link);

                for (const pl of pageLinks) {
                    if (pl.host === 'pastebin' && pl.url.includes('paste.fitgirl-repacks.site')) {
                        const pasteLinks = await getPastebinLinks(pl.url);
                        allLinks = allLinks.concat(pasteLinks);
                    } else {
                        allLinks.push(pl);
                    }
                }

                // Remove duplicates by URL
                const seen = new Set();
                allLinks = allLinks.filter(l => {
                    if (seen.has(l.url)) return false;
                    seen.add(l.url);
                    return true;
                });

                if (allLinks.length === 0) {
                    return await sock.sendMessage(chatJid, { text: `❌ *${selectedGame.title}* සඳහා download links සොයාගත නොහැකි විය.`, edit: linkMsg.key });
                }

                let linksText = `*🎮 ${selectedGame.title}*\n\n`;
                linksText += `*📦 Total Parts:* ${allLinks.length}\n\n`;
                linksText += `*Download Links:*\n\n`;

                allLinks.forEach((l, i) => {
                    linksText += `${i + 1}. *${l.fileName}* _(Host: ${l.host})_\n`;
                });

                linksText += `\n\n*📥 Download Commands:*\n`;
                linksText += `• \`.si all\` - සියලුම parts inbox එකට\n`;
                linksText += `• \`.sg [group name] all\` - සියලුම parts group එකට\n`;
                linksText += `• \`.si [number]\` - ඒ අංකයේ සිට ඉදිරියට\n`;
                linksText += `• \`.sg [group name] [number]\` - ඒ අංකයේ සිට group එකට\n`;
                linksText += `\n*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*`;

                session.selectedGame = selectedGame;
                session.links = allLinks;
                fitgirlSessions.set(chatJid, session);

                await sock.sendMessage(chatJid, { text: linksText, edit: linkMsg.key });

            } catch (error) {
                console.error('.fg links error:', error);
                await sock.sendMessage(chatJid, { text: `❌ Links ලබා ගැනීමේදී දෝෂයක්: ${error.message}`, edit: linkMsg.key });
            }
        }

        // ═══════════════════════════════════════════════════════
        // 📥 .si all
        // ═══════════════════════════════════════════════════════
        else if (text.trim() === '.si all') {
            const session = fitgirlSessions.get(chatJid);
            if (!session || !session.links || session.links.length === 0) {
                return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර පළමුව `.fg [game name]` භාවිතා කර game එක select කරන්න.' }, { quoted: msg });
            }

            const startTime = Date.now();
            let uploadedCount = 0;
            let failedCount = 0;
            let wasStopped = false;
            const totalParts = session.links.length;

            const initialNotify = await sock.sendMessage(chatJid, { text: `📥 *${session.selectedGame?.title || 'Game'}* හි සියලුම ${totalParts} parts inbox එකට යවමින්...` });

            for (let i = 0; i < session.links.length; i++) {
                const linkObj = session.links[i];
                console.log(`[DOWNLOAD] Processing part ${i + 1}/${totalParts}: ${linkObj.fileName}`);

                const realUrl = await resolveDirectLink(linkObj.url);

                if (!realUrl) {
                    console.log(`[DOWNLOAD] Failed to resolve: ${linkObj.url}`);
                    failedCount++;
                    continue;
                }

                const success = await handleDownloadAndUpload(realUrl, sock, msg, senderJid, linkObj.fileName);
                if (success === 'STOPPED') {
                    wasStopped = true;
                    break;
                }
                if (success) uploadedCount++;
            }

            const endTime = Date.now();
            const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

            if (uploadedCount > 0 && !wasStopped) {
                const summaryText = 
                    `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                    `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                    `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                    `┌────────────────────────\n` +
                    `│ ✅ Status: Done\n` +
                    `│ 📦 Total Parts: ${uploadedCount}\n` +
                    `│ ❌ Failed: ${failedCount}\n` +
                    `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
                    `└────────────────────────\n\n` +
                    `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                await sock.sendMessage(chatJid, { text: summaryText });
                await sock.sendMessage(chatJid, { text: `✅ සියලුම Parts (${uploadedCount}) inbox එකට සාර්ථකව යවන ලදී!`, edit: initialNotify.key });
            } else if (wasStopped) {
                await sock.sendMessage(chatJid, { text: `🛑 *ක්‍රියාවලිය නවත්වන ලද නිසා යැවීම අවලංගු කරන ලදී.*`, edit: initialNotify.key });
            }
        }

        // ═══════════════════════════════════════════════════════
        // 👥 .sg [group] all
        // ═══════════════════════════════════════════════════════
        else if (text.match(/^\.sg\s+.+\s+all$/i)) {
            const session = fitgirlSessions.get(chatJid);
            if (!session || !session.links || session.links.length === 0) {
                return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර පළමුව `.fg [game name]` භාවිතා කර game එක select කරන්න.' }, { quoted: msg });
            }

            const groupName = text.replace('.sg ', '').replace(/\s+all$/i, '').trim().toLowerCase();

            const initialNotify = await sock.sendMessage(chatJid, { text: `🔍 '${groupName}' ගෲප් එක සොයමින් පවතී...` });

            try {
                const groups = await sock.groupFetchAllParticipating();
                let targetGroupJid = null;

                for (let jid in groups) {
                    if (groups[jid].subject.toLowerCase().includes(groupName)) {
                        targetGroupJid = jid; break;
                    }
                }

                if (!targetGroupJid) return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.' });

                const startTime = Date.now();
                let uploadedCount = 0;
                let failedCount = 0;
                let wasStopped = false;
                const totalParts = session.links.length;

                await sock.sendMessage(chatJid, { text: `📥 *${session.selectedGame?.title || 'Game'}* හි සියලුම ${totalParts} parts '${groups[targetGroupJid].subject}' ගෲප් එකට යවමින්...`, edit: initialNotify.key });

                for (let i = 0; i < session.links.length; i++) {
                    const linkObj = session.links[i];
                    const realUrl = await resolveDirectLink(linkObj.url);

                    if (!realUrl) {
                        failedCount++;
                        continue;
                    }

                    const success = await handleDownloadAndUpload(realUrl, sock, msg, targetGroupJid, linkObj.fileName);
                    if (success === 'STOPPED') {
                        wasStopped = true;
                        break;
                    }
                    if (success) uploadedCount++;
                }

                const endTime = Date.now();
                const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

                if (uploadedCount > 0 && !wasStopped) {
                    const summaryText = 
                        `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                        `┌────────────────────────\n` +
                        `│ ✅ Status: Done\n` +
                        `│ 📦 Total Parts: ${uploadedCount}\n` +
                        `│ ❌ Failed: ${failedCount}\n` +
                        `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
                        `└────────────────────────\n\n` +
                        `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                    await sock.sendMessage(targetGroupJid, { text: summaryText });
                    await sock.sendMessage(chatJid, { text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!`, edit: initialNotify.key });
                } else if (wasStopped) {
                    await sock.sendMessage(chatJid, { text: `🛑 *ක්‍රියාවලිය නවත්වන ලද නිසා ගෲප් වාර්තා යැවීම අවලංගු කරන ලදී.*`, edit: initialNotify.key });
                }

            } catch (error) {
                await sock.sendMessage(chatJid, { text: '❌ ගෲප් එකට යැවීමේදී දෝෂයක් ඇති විය.' });
            }
        }

        // ═══════════════════════════════════════════════════════
        // 📥 .si [number]
        // ═══════════════════════════════════════════════════════
        else if (text.match(/^\.si\s+\d+$/)) {
            const partNum = parseInt(text.replace('.si ', '').trim());
            const session = fitgirlSessions.get(chatJid);

            if (!session || !session.links || session.links.length === 0) {
                return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර පළමුව `.fg [game name]` භාවිතා කර game එක select කරන්න.' }, { quoted: msg });
            }

            if (partNum < 1 || partNum > session.links.length) {
                return await sock.sendMessage(chatJid, { text: `❌ අංකය 1 සිට ${session.links.length} දක්වා විය යුතුය.` });
            }

            const startTime = Date.now();
            let uploadedCount = 0;
            let failedCount = 0;
            let wasStopped = false;
            const linksToDownload = session.links.slice(partNum - 1);

            const initialNotify = await sock.sendMessage(chatJid, { text: `📥 Part ${partNum} සිට ${session.links.length} දක්වා inbox එකට යවමින්...` });

            for (let i = 0; i < linksToDownload.length; i++) {
                const linkObj = linksToDownload[i];
                const realUrl = await resolveDirectLink(linkObj.url);

                if (!realUrl) {
                    failedCount++;
                    continue;
                }

                const success = await handleDownloadAndUpload(realUrl, sock, msg, senderJid, linkObj.fileName);
                if (success === 'STOPPED') {
                    wasStopped = true;
                    break;
                }
                if (success) uploadedCount++;
            }

            const endTime = Date.now();
            const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

            if (uploadedCount > 0 && !wasStopped) {
                const summaryText = 
                    `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                    `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                    `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                    `┌────────────────────────\n` +
                    `│ ✅ Status: Done\n` +
                    `│ 📦 Total Parts: ${uploadedCount}\n` +
                    `│ ❌ Failed: ${failedCount}\n` +
                    `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
                    `└────────────────────────\n\n` +
                    `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                await sock.sendMessage(chatJid, { text: summaryText });
                await sock.sendMessage(chatJid, { text: `✅ Parts (${uploadedCount}) inbox එකට සාර්ථකව යවන ලදී!`, edit: initialNotify.key });
            } else if (wasStopped) {
                await sock.sendMessage(chatJid, { text: `🛑 *ක්‍රියාවලිය නවත්වන ලදී.*`, edit: initialNotify.key });
            }
        }

        // ═══════════════════════════════════════════════════════
        // 👥 .sg [group] [number]
        // ═══════════════════════════════════════════════════════
        else if (text.match(/^\.sg\s+.+\s+\d+$/)) {
            const match = text.match(/^\.sg\s+(.+)\s+(\d+)$/);
            if (!match) return;

            const groupName = match[1].trim().toLowerCase();
            const partNum = parseInt(match[2]);

            const session = fitgirlSessions.get(chatJid);
            if (!session || !session.links || session.links.length === 0) {
                return await sock.sendMessage(chatJid, { text: '❌ කරුණාකර පළමුව `.fg [game name]` භාවිතා කර game එක select කරන්න.' }, { quoted: msg });
            }

            if (partNum < 1 || partNum > session.links.length) {
                return await sock.sendMessage(chatJid, { text: `❌ අංකය 1 සිට ${session.links.length} දක්වා විය යුතුය.` });
            }

            const initialNotify = await sock.sendMessage(chatJid, { text: `🔍 '${groupName}' ගෲප් එක සොයමින් පවතී...` });

            try {
                const groups = await sock.groupFetchAllParticipating();
                let targetGroupJid = null;

                for (let jid in groups) {
                    if (groups[jid].subject.toLowerCase().includes(groupName)) {
                        targetGroupJid = jid; break;
                    }
                }

                if (!targetGroupJid) return await sock.sendMessage(chatJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.' });

                const startTime = Date.now();
                let uploadedCount = 0;
                let failedCount = 0;
                let wasStopped = false;
                const linksToDownload = session.links.slice(partNum - 1);

                await sock.sendMessage(chatJid, { text: `📥 Part ${partNum} සිට ${session.links.length} දක්වා '${groups[targetGroupJid].subject}' ගෲප් එකට යවමින්...`, edit: initialNotify.key });

                for (let i = 0; i < linksToDownload.length; i++) {
                    const linkObj = linksToDownload[i];
                    const realUrl = await resolveDirectLink(linkObj.url);

                    if (!realUrl) {
                        failedCount++;
                        continue;
                    }

                    const success = await handleDownloadAndUpload(realUrl, sock, msg, targetGroupJid, linkObj.fileName);
                    if (success === 'STOPPED') {
                        wasStopped = true;
                        break;
                    }
                    if (success) uploadedCount++;
                }

                const endTime = Date.now();
                const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

                if (uploadedCount > 0 && !wasStopped) {
                    const summaryText = 
                        `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                        `┌────────────────────────\n` +
                        `│ ✅ Status: Done\n` +
                        `│ 📦 Total Parts: ${uploadedCount}\n` +
                        `│ ❌ Failed: ${failedCount}\n` +
                        `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
                        `└────────────────────────\n\n` +
                        `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                    await sock.sendMessage(targetGroupJid, { text: summaryText });
                    await sock.sendMessage(chatJid, { text: `✅ Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවන ලදී!`, edit: initialNotify.key });
                } else if (wasStopped) {
                    await sock.sendMessage(chatJid, { text: `🛑 *ක්‍රියාවලිය නවත්වන ලදී.*`, edit: initialNotify.key });
                }

            } catch (error) {
                await sock.sendMessage(chatJid, { text: '❌ ගෲප් එකට යැවීමේදී දෝෂයක් ඇති විය.' });
            }
        }

        // ═══════════════════════════════════════════════════════
        // 1️⃣ .si (Direct URL)
        // ═══════════════════════════════════════════════════════
        else if (text.startsWith('.si ') && !text.match(/^\.si\s+\d+$/) && text.trim() !== '.si all') {
            if (urls.length === 0) return await sock.sendMessage(msg.key.remoteJid, { text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.' }, { quoted: msg });
            for (let url of urls) {
                const res = await handleDownloadAndUpload(url, sock, msg, senderJid);
                if (res === 'STOPPED') break; 
            }
        }

        // 2️⃣ .sg (Direct URL)
        // ═══════════════════════════════════════════════════════
        else if (text.startsWith('.sg ') && !text.match(/^\.sg\s+.+\s+all$/i) && !text.match(/^\.sg\s+.+\s+\d+$/)) {
            if (urls.length === 0) return await sock.sendMessage(msg.key.remoteJid, { text: '❌ කරුණාකර වලංගු ලින්ක් එකක් ලබා දෙන්න.' }, { quoted: msg });

            let groupName = text.replace('.sg ', '');
            urls.forEach(u => groupName = groupName.replace(u, ''));
            groupName = groupName.trim().toLowerCase();

            if (!groupName) return await sock.sendMessage(msg.key.remoteJid, { text: '❌ කරුණාකර ගෲප් එකේ නම සඳහන් කරන්න.' }, { quoted: msg });
            const initialNotify = await sock.sendMessage(msg.key.remoteJid, { text: `🔍 '${groupName}' ගෲප් එක සොයමින් පවතී...` });

            try {
                const groups = await sock.groupFetchAllParticipating();
                let targetGroupJid = null;

                for (let jid in groups) {
                    if (groups[jid].subject.toLowerCase().includes(groupName)) {
                        targetGroupJid = jid; break;
                    }
                }

                if (!targetGroupJid) return await sock.sendMessage(msg.key.remoteJid, { text: '❌ ඒ නමින් ගෲප් එකක් සොයාගත නොහැකි විය.' });

                const startTime = Date.now();
                let uploadedCount = 0;
                let wasStopped = false;

                for (let url of urls) {
                    const success = await handleDownloadAndUpload(url, sock, msg, targetGroupJid);
                    if (success === 'STOPPED') {
                        wasStopped = true;
                        break;
                    }
                    if (success) uploadedCount++;
                }

                const endTime = Date.now();
                const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

                if (uploadedCount > 0 && !wasStopped) {
                    const summaryText = 
                        `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                        `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                        `┌────────────────────────\n` +
                        `│ ✅ Status: Done\n` +
                        `│ 📦 Total Parts: ${uploadedCount}\n` +
                        `│ ⏱️ Time Taken: ${totalTimeSeconds}s\n` +
                        `└────────────────────────\n\n` +
                        `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                    await sock.sendMessage(targetGroupJid, { text: summaryText });
                    await sock.sendMessage(msg.key.remoteJid, { text: `✅ සියලුම Parts (${uploadedCount}) ගෲප් එකට සාර්ථකව යවා Summary වාර්තාවද ලබා දෙන ලදී!`, edit: initialNotify.key });
                } else if (wasStopped) {
                    await sock.sendMessage(msg.key.remoteJid, { text: `🛑 *ක්‍රියාවලිය නවත්වන ලද නිසා ගෲප් වාර්තා යැවීම අවලංගු කරන ලදී.*`, edit: initialNotify.key });
                }

            } catch (error) {
                await sock.sendMessage(msg.key.remoteJid, { text: '❌ ගෲප් එකට යැවීමේදී දෝෂයක් ඇති විය.' });
            }
        }

        // 3️⃣ .stop
        // ═══════════════════════════════════════════════════════
        else if (text.trim().startsWith('.stop')) { 
            if (activeTasks.has(chatJid)) {
                const task = activeTasks.get(chatJid);

                task.controller.abort();
                if (task.uploadInterval) clearInterval(task.uploadInterval);
                if (task.stream) { try { task.stream.destroy(); } catch(e){} } 
                if (task.writer) { try { task.writer.destroy(); } catch(e){} }

                if (task.progressMsgKey) {
                    const stoppedText = `┏━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                                        `        ⚙️ 𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 ⚙️\n` +
                                        `┗━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                                        `🛑 *Status: Process Stopped!*\n` +
                                        `⚠️ _දත්ත බාගත කිරීම හෝ යැවීම පරිශීලකයා විසින් නවතා දමා ඇත._\n\n` +
                                        `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;
                    await sock.sendMessage(chatJid, { text: stoppedText, edit: task.progressMsgKey }).catch(() => {});
                }

                setTimeout(() => {
                    if (task.tempFilePath && fs.existsSync(task.tempFilePath)) {
                        try { fs.unlinkSync(task.tempFilePath); } catch (e) {}
                    }
                }, 1000);

                activeTasks.delete(chatJid);
                await sock.sendMessage(chatJid, { text: '✅ සියලුම සක්‍රීය ඩවුන්ලෝඩ්/අප්ලෝඩ් ක්‍රියාවලීන් නතර කර දත්ත ඉවත් කරන ලදී!' }, { quoted: msg });
            } else {
                await sock.sendMessage(chatJid, { text: '❌ මේ මොහොතේ කිසිදු ෆයිල් එකක් බාගත වෙමින් පවතින්නේ නැත.' }, { quoted: msg });
            }
        }

        // 4️⃣ .speed
        // ═══════════════════════════════════════════════════════
        else if (text.trim() === '.speed') {
            await sock.sendMessage(msg.key.remoteJid, { text: '⚡ RV Games සර්වර් වේගය පරීක්ෂා කරමින් පවතී...' }, { quoted: msg });
            try {
                const pingStart = Date.now();
                await axios.get('https://google.com');
                const pingTime = Date.now() - pingStart;

                const dlStart = Date.now();
                await axios.get('https://httpbin.org/bytes/1048576', { responseType: 'arraybuffer' }); 
                const dlEnd = Date.now();
                const dlDuration = (dlEnd - dlStart) / 1000;
                const downloadSpeed = (8 / dlDuration).toFixed(2);

                const payload = 'A'.repeat(1048576);
                const ulStart = Date.now();
                await axios.post('https://httpbin.org/post', payload, {
                    headers: { 'Content-Type': 'text/plain' }
                });
                const ulEnd = Date.now();
                const ulDuration = (ulEnd - ulStart) / 1000;
                const uploadSpeed = (8 / ulDuration).toFixed(2);

                const speedText = `*⚡ RV GAMES SERVER SPEED* 🎮\n\n` +
                                  `🏓 *Ping:* \`${pingTime} ms\`\n` +
                                  `📥 *Download Speed:* \`${downloadSpeed} Mbps\`\n` +
                                  `📤 *Upload Speed:* \`${uploadSpeed} Mbps\`\n\n` +
                                  `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                await sock.sendMessage(msg.key.remoteJid, { text: speedText }, { quoted: msg });
            } catch (error) {
                console.error("Speed test Error:", error.message);
                await sock.sendMessage(msg.key.remoteJid, { text: `❌ Speed test දෝෂයකි: ${error.message}` }, { quoted: msg });
            }
        }

        // 5️⃣ .dc
        // ═══════════════════════════════════════════════════════
        else if (text.trim() === '.dc') {
            await sock.sendMessage(msg.key.remoteJid, { text: '🧹 RV Games සර්වර් එකේ තාවකාලික ෆයිල් ඉවත් කරමින් පවතී...' }, { quoted: msg });
            try {
                const directory = './';
                const files = fs.readdirSync(directory);
                let deletedCount = 0;
                let freedSpace = 0;

                files.forEach(file => {
                    const filePath = path.join(directory, file);
                    const stat = fs.statSync(filePath);

                    const protectedFiles = ['index.js', 'package.json', 'package-lock.json', 'node_modules', 'bot_session', '.env', '.gitignore', '.git'];

                    if (!protectedFiles.includes(file) && stat.isFile()) {
                        freedSpace += stat.size;
                        fs.unlinkSync(filePath);
                        deletedCount++;
                    }
                });

                const freedMB = (freedSpace / (1024 * 1024)).toFixed(2);

                const clearText = `*🧹 RV GAMES DISK CLEANER* ⚙️\n\n` +
                                  `✅ *Status:* Disk Cleaned Successfully!\n` +
                                  `🗑️ *Removed Files:* \`${deletedCount} files\`\n` +
                                  `📦 *Freed Space:* \`${freedMB} MB\`\n\n` +
                                  `*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈  RV Games*`;

                await sock.sendMessage(msg.key.remoteJid, { text: clearText }, { quoted: msg });
            } catch (error) {
                console.error("Disk Cleaner Error:", error.message);
                await sock.sendMessage(msg.key.remoteJid, { text: `❌ Disk එක Clear කිරීමේදී දෝෂයක් ඇති විය: ${error.message}` }, { quoted: msg });
            }
        }

        // 6️⃣ .crash
        // ═══════════════════════════════════════════════════════
        else if (text.trim() === '.crash') {
            await sock.sendMessage(msg.key.remoteJid, { text: '💀 *RV Games Bot Offline කරනු ලදී.*\n🚫 _සර්වර් එක තවදුරටත් ක්‍රියාත්මක නොවේ._' }, { quoted: msg });
            console.log("💀 Manual Crash triggered: Bot stopped.");

            setTimeout(() => {
                process.exit(0); 
            }, 1000);
        }

        // 7️⃣ .menu
        // ═══════════════════════════════════════════════════════
        else if (text.trim() === '.menu') {
            const menuText = 
                `*👑𝚁𝚅 𝙶𝙰𝙼𝙴𝚂 𝙾𝙵𝙵𝙸𝙲𝙸𝙰𝙻 𝙱𝙾𝚃*👑\n\n` +
                `╔════════════════════╗\n` +
                `┃    🤖 *MAIN COMMANDS MENU* \n` +
                `╚════════════════════╝\n` +
                `┃ 🎮 *.fg [game name]*\n` +
                `┃ ↳ _FitGirl Repacks වලින් game search කර links ලබා ගනී._\n` +
                `┃\n` +
                `┃ 📥 *.si [link 1] [link 2]*\n` +
                `┃ ↳ _ලින්ක් කීපයක් වුවද එකවර Inbox එවයි._\n` +
                `┃\n` +
                `┃ 👥 *.sg [group name] [link 1] [link 2]*\n` +
                `┃ ↳ _අදාළ ගෲප් එක වෙත ෆයිල්ස් සහ Summary වාර්තාව යවයි._\n` +
                `┃\n` +
                `┃ 🛑 *.stop*\n` +
                `┃ ↳ _සිදු වෙමින් පවතින ඕනෑම ක්‍රියාවලියක් නතර කරයි._\n` +
                `┃\n` +
                `┃ ⚡ *.speed*\n` +
                `┃ ↳ _සර්වර් එකේ සැබෑ DL වේගය මනියි._\n` +
                `┃\n` +
                `┃ 🧹 *.dc*\n` +
                `┃ ↳ _සර්වර් එකේ ඇති තාවකාලික ෆයිල් මකා දමයි._\n` +
                `┃\n` +
                `┃ 📜 *.menu*\n` +
                `┃ ↳ _මෙම විධාන මෙනුව ලබා දෙයි._\n` +
                `╚════════════════════╝\n\n` +
                `*🎮 FitGirl Download Commands (after .fg search):*\n` +
                `┃ • \`.si all\` - සියලුම parts inbox එකට\n` +
                `┃ • \`.sg [group] all\` - සියලුම parts group එකට\n` +
                `┃ • \`.si [number]\` - ඒ අංකයේ සිට inbox එකට\n` +
                `┃ • \`.sg [group] [number]\` - ඒ අංකයේ සිට group එකට\n` +
                `╚════════════════════╝\n\n` +
                `_*𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 RV Games*_`;

            await sock.sendMessage(msg.key.remoteJid, { text: menuText }, { quoted: msg });
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
                if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                process.exit(1); 
            } else {
                setTimeout(() => startBot(), 5000); 
            }
        } else if (connection === 'open') {
            console.log('🎉 RV Games Bot Connected Successfully!');
        }
    });
}

startBot();
