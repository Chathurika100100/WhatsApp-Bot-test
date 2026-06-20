import 'dotenv/config'; 
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import http from 'http'; 
import axios from 'axios'; 
import NodeCache from 'node-cache';
import * as cheerio from 'cheerio';
import cloudscraper from 'cloudscraper';

// Web Server
const server = http.createServer((req, res) => {
    res.end('RV Games Ultra Bot is Online!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
});

const authFolder = './bot_session';
const activeTasks = new Map(); 
const msgRetryCounterCache = new NodeCache();
const fitgirlSessions = new Map();

function setupSession() {
    const credsPath = path.join(authFolder, 'creds.json');
    if (fs.existsSync(credsPath)) return console.log("Old session found...");

    const sessionId = process.env.SESSION_ID;
    if (!sessionId) {
        console.error("ERROR: SESSION_ID not set in Railway Variables!");
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
        console.log("SESSION_ID loaded successfully!");
    } catch (err) {
        console.error("ERROR: Invalid SESSION_ID!");
        process.exit(1); 
    }
}
setupSession();

function getProgressBar(percent) {
    const total = 10;
    const filled = Math.round((percent / 100) * total);
    const empty = total - filled;
    return '▰'.repeat(filled) + '▱'.repeat(empty);
}

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

async function resolveFuckingFast(url) {
    try {
        console.log(`[RESOLVER] Resolving: ${url}`);

        let html = '';
        try {
            html = await cloudscraper({
                uri: url,
                headers: {
                    ...BROWSER_HEADERS,
                    'Referer': 'https://fitgirl-repacks.site/'
                },
                timeout: 25000
            });
            console.log(`[RESOLVER] Cloudscraper success`);
        } catch (csError) {
            console.log(`[RESOLVER] Cloudscraper failed: ${csError.message}`);
            const response = await axios.get(url, {
                headers: { ...BROWSER_HEADERS, 'Referer': 'https://fitgirl-repacks.site/' },
                timeout: 20000, maxRedirects: 5, validateStatus: () => true
            });
            if (response.status !== 200) {
                console.log(`[RESOLVER] Axios status: ${response.status}`);
                return null;
            }
            html = response.data;
        }

        // Pattern 1: window.open with quotes
        let m = html.match(/window\.open\(["'](https:\/\/dl\.fuckingfast\.co\/[^"']+)["']/);
        if (m && m[1]) { console.log(`[RESOLVER] Found: ${m[1]}`); return m[1]; }

        // Pattern 2: window.open with escaped quotes
        m = html.match(/window\.open\("(https:\/\/dl\.fuckingfast\.co\/[^"]+)"/);
        if (m && m[1]) { console.log(`[RESOLVER] Found: ${m[1]}`); return m[1]; }

        // Pattern 3: Any dl.fuckingfast.co URL
        m = html.match(/(https:\/\/dl\.fuckingfast\.co\/[^\s"'<>]+)/);
        if (m && m[1]) { console.log(`[RESOLVER] Found: ${m[1]}`); return m[1]; }

        // Pattern 4: onclick
        m = html.match(/onclick=["'].*?(https:\/\/dl\.fuckingfast\.co\/[^"']+)["']/);
        if (m && m[1]) { console.log(`[RESOLVER] Found: ${m[1]}`); return m[1]; }

        // Pattern 5: href
        m = html.match(/href=["'](https:\/\/dl\.fuckingfast\.co\/[^"']+)["']/);
        if (m && m[1]) { console.log(`[RESOLVER] Found: ${m[1]}`); return m[1]; }

        console.log(`[RESOLVER] No direct link found`);
        return null;
    } catch (error) {
        console.error(`[RESOLVER] Error: ${error.message}`);
        return null;
    }
}

async function handleDownloadAndUpload(url, sock, msg, sendToJid, fileNameOverride = null) {
    const chatJid = msg.key.remoteJid;
    const progressMsg = await sock.sendMessage(chatJid, { text: `Checking link...` }, { quoted: msg });

    const controller = new AbortController();
    activeTasks.set(chatJid, {
        controller, progressMsgKey: progressMsg.key,
        uploadInterval: null, tempFilePath: null, writer: null, stream: null 
    });

    let tempFilePath = '';

    try {
        const response = await axios({
            url, method: 'GET', responseType: 'stream',
            signal: controller.signal, 
            headers: BROWSER_HEADERS, maxRedirects: 10, timeout: 300000
        });

        if (activeTasks.has(chatJid)) activeTasks.get(chatJid).stream = response.data;

        let fileName = fileNameOverride || '';
        const cd = response.headers['content-disposition'];
        const ct = response.headers['content-type'] || 'application/octet-stream';

        if (!fileName && cd) {
            const um = cd.match(/filename\*=\s*UTF-8''([^;\r\n]*)/i);
            if (um && um[1]) fileName = decodeURIComponent(um[1]);
            else {
                const nm = cd.match(/filename\s*=\s*["']?([^;\r\n"']*)["']?/i);
                if (nm && nm[1]) fileName = nm[1];
            }
        }

        if (!fileName) {
            try {
                const parts = url.split('/');
                const last = parts[parts.length - 1];
                const clean = last.split('?')[0].split('#')[0];
                if (clean && clean.includes('.')) fileName = decodeURIComponent(clean);
            } catch (e) {}
        }

        if (fileName) fileName = fileName.replace(/[/\\?%*:|"<>]/g, '-').trim(); 
        if (!fileName || fileName.length > 200) fileName = `RV_Games_File_${Math.floor(Math.random() * 10000)}`;
        if (!fileName.includes('.')) fileName += getExtensionFromMime(ct);

        const totalLength = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedLength = 0;
        let lastUpdateTime = Date.now();

        tempFilePath = path.join('./', `${Date.now()}_${fileName}`);
        const writer = fs.createWriteStream(tempFilePath);

        if (activeTasks.has(chatJid)) activeTasks.get(chatJid).writer = writer;

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
                    const text = `Downloading: ${fileName}\n${bar} ${percent}%\n${dlMB}MB / ${totMB}MB`;
                    await sock.sendMessage(chatJid, { text, edit: progressMsg.key }).catch(() => {});
                } else {
                    const text = `Downloading: ${fileName}\nDownloaded: ${dlMB}MB`;
                    await sock.sendMessage(chatJid, { text, edit: progressMsg.key }).catch(() => {});
                }
            }
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
            controller.signal.addEventListener('abort', () => { writer.destroy(); reject(new Error('STOPPED')); });
        });

        let uploadPercent = 0;
        const totalMB = totalLength ? (totalLength / (1024 * 1024)).toFixed(1) : (downloadedLength / (1024 * 1024)).toFixed(1);

        const uploadInterval = setInterval(async () => {
            if (controller.signal.aborted) { clearInterval(uploadInterval); return; }
            if (uploadPercent < 90) {
                uploadPercent += Math.floor(Math.random() * 12) + 6; 
                if (uploadPercent > 94) uploadPercent = 94;
                const upMB = ((uploadPercent / 100) * totalMB).toFixed(1);
                const bar = getProgressBar(uploadPercent);
                const text = `Uploading: ${fileName}\n${bar} ${uploadPercent.toFixed(1)}%\n${upMB}MB / ${totalMB}MB`;
                await sock.sendMessage(chatJid, { text, edit: progressMsg.key }).catch(() => {});
            }
        }, 1500);

        if (activeTasks.has(chatJid)) activeTasks.get(chatJid).uploadInterval = uploadInterval;

        await sock.sendMessage(sendToJid, { 
            document: { url: tempFilePath }, mimetype: ct, fileName: fileName,
            caption: `POWERED BY RV Games`
        });

        clearInterval(uploadInterval);
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); 
        activeTasks.delete(chatJid);

        await sock.sendMessage(chatJid, { text: `${fileName} sent successfully!`, edit: progressMsg.key }).catch(() => {});
        return true; 

    } catch (error) {
        const task = activeTasks.get(chatJid);
        if (task) {
            if (task.uploadInterval) clearInterval(task.uploadInterval);
            if (task.writer) { try { task.writer.destroy(); } catch(e){} }
            if (task.stream) { try { task.stream.destroy(); } catch(e){} }
        }
        if (tempFilePath && fs.existsSync(tempFilePath)) { try { fs.unlinkSync(tempFilePath); } catch (e) {} }

        if (axios.isCancel(error) || error.message === 'STOPPED' || controller.signal.aborted) {
            activeTasks.delete(chatJid); return 'STOPPED'; 
        }

        console.error(`[DOWNLOAD ERROR] ${error.message}`);
        activeTasks.delete(chatJid);
        await sock.sendMessage(chatJid, { text: `Error: ${error.message}`, edit: progressMsg.key }).catch(() => {});
        return false;
    }
}

async function searchFitGirl(gameName) {
    try {
        const searchUrl = `https://fitgirl-repacks.site/?s=${encodeURIComponent(gameName)}`;
        console.log(`[SCRAPER] Searching: ${searchUrl}`);
        const response = await axios.get(searchUrl, { headers: BROWSER_HEADERS, timeout: 15000 });
        const $ = cheerio.load(response.data);
        const results = [];
        $('article.type-post').each((i, el) => {
            const titleEl = $(el).find('h1.entry-title a, h2.entry-title a').first();
            const title = titleEl.text().trim();
            const link = titleEl.attr('href');
            const excerpt = $(el).find('.entry-summary p').first().text().trim().substring(0, 200);
            if (title && link) {
                results.push({ number: i + 1, title, link, excerpt: excerpt || 'No description' });
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
        console.log(`[SCRAPER] Fetching: ${gameUrl}`);
        const response = await axios.get(gameUrl, { headers: BROWSER_HEADERS, timeout: 15000 });
        const $ = cheerio.load(response.data);
        const links = [];
        $('a[href*="fuckingfast.co"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('#')) {
                links.push({ host: 'fuckingfast', url: href, fileName: href.split('#').pop() });
            }
        });
        $('a[href*="paste.fitgirl-repacks.site"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) links.push({ host: 'pastebin', url: href, fileName: 'pastebin_links' });
        });
        console.log(`[SCRAPER] Found ${links.length} links`);
        return links;
    } catch (error) {
        console.error('[SCRAPER] Links Error:', error.message);
        return [];
    }
}

async function getPastebinLinks(pasteUrl) {
    try {
        console.log(`[SCRAPER] Pastebin: ${pasteUrl}`);
        const response = await axios.get(pasteUrl, { headers: BROWSER_HEADERS, timeout: 15000 });
        const $ = cheerio.load(response.data);
        const links = [];
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('fuckingfast.co') && href.includes('#')) {
                const fileName = href.split('#').pop();
                if (!links.some(l => l.url === href)) {
                    links.push({ host: 'fuckingfast', url: href, fileName });
                }
            }
        });
        console.log(`[SCRAPER] Pastebin: ${links.length} links`);
        return links;
    } catch (error) {
        console.error('[SCRAPER] Pastebin Error:', error.message);
        return [];
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion(); 

    const sock = makeWASocket({
        version, auth: state, printQRInTerminal: false,
        logger: pino({ level: 'silent' }), 
        browser: ['RV Games Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false, msgRetryCounterCache
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return; 

        let text = '';
        if (msg.message.conversation) text = msg.message.conversation;
        else if (msg.message.extendedTextMessage) text = msg.message.extendedTextMessage.text || '';
        else if (msg.message.imageMessage) text = msg.message.imageMessage.caption || '';
        else if (msg.message.videoMessage) text = msg.message.videoMessage.caption || '';

        text = text.trim();

        const isReplyToBot = msg.message.extendedTextMessage?.contextInfo?.stanzaId !== undefined;
        const session = fitgirlSessions.get(msg.key.remoteJid);
        const isNumberOnly = /^\d+$/.test(text);

        console.log(`[MSG] From: ${msg.key.remoteJid}, Text: "${text}", Reply: ${isReplyToBot}`);

        if (isNumberOnly && session && session.results && isReplyToBot) {
            text = `.fg ${text}`;
            console.log(`[AUTO] Converted to: "${text}"`);
        }

        if (!text.startsWith('.')) return; 

        const senderJid = msg.key.participant || msg.key.remoteJid || ""; 
        const chatJid = msg.key.remoteJid;

        const allowedNumbers = ['94701030330', '94740375946', '212038592811214', '275698514133039']; 
        const senderNumber = senderJid.split('@')[0].split(':')[0]; 

        console.log(`[SECURITY] From: ${senderNumber}`);

        if (!allowedNumbers.includes(senderNumber)) {
            const pm = `RV GAMES PRIVATE SYSTEM\n\nSorry, Access Denied!\nYou are not authorized.\n\nPOWERED BY RV Games`;
            return await sock.sendMessage(chatJid, { text: pm }, { quoted: msg });
        }

        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = text.match(urlRegex) || [];

        // .fg [game name]
        if (text.startsWith('.fg ') && !text.match(/^\.fg\s+\d+$/)) {
            const gameName = text.replace('.fg ', '').trim();
            if (!gameName) {
                return await sock.sendMessage(chatJid, { text: 'Please provide a game name. Example: .fg Far Cry 3' }, { quoted: msg });
            }

            const searchMsg = await sock.sendMessage(chatJid, { text: `Searching FitGirl for '${gameName}'...` }, { quoted: msg });

            try {
                const results = await searchFitGirl(gameName);
                if (results.length === 0) {
                    return await sock.sendMessage(chatJid, { text: `No results found for '${gameName}'.`, edit: searchMsg.key });
                }

                let rt = `FitGirl Repacks Search Results\n\nQuery: ${gameName}\nFound: ${results.length} game(s)\n\nReply with number to get links:\n\n`;
                results.forEach((r, i) => {
                    rt += `${i + 1}. ${r.title}\n`;
                    if (r.excerpt) rt += `   ${r.excerpt}\n`;
                    rt += `\n`;
                });
                rt += `\nReply: 1 or .fg 1\n\nPOWERED BY RV Games`;

                fitgirlSessions.set(chatJid, { gameName, results, links: [], timestamp: Date.now() });
                await sock.sendMessage(chatJid, { text: rt, edit: searchMsg.key });

            } catch (error) {
                console.error('.fg error:', error);
                await sock.sendMessage(chatJid, { text: `Search error: ${error.message}`, edit: searchMsg.key });
            }
        }

        // .fg [number]
        else if (text.match(/^\.fg\s+\d+$/)) {
            const selectedNum = parseInt(text.replace('.fg ', '').trim());
            const session = fitgirlSessions.get(chatJid);

            if (!session || !session.results || session.results.length === 0) {
                return await sock.sendMessage(chatJid, { text: 'Please search first with .fg [game name]' }, { quoted: msg });
            }

            const selectedGame = session.results.find(r => r.number === selectedNum);
            if (!selectedGame) {
                return await sock.sendMessage(chatJid, { text: `No result for number ${selectedNum}.` }, { quoted: msg });
            }

            const linkMsg = await sock.sendMessage(chatJid, { text: `Getting links for ${selectedGame.title}...` }, { quoted: msg });

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

                const seen = new Set();
                allLinks = allLinks.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });

                if (allLinks.length === 0) {
                    return await sock.sendMessage(chatJid, { text: `No download links found for ${selectedGame.title}.`, edit: linkMsg.key });
                }

                let lt = `${selectedGame.title}\n\nTotal Parts: ${allLinks.length}\n\nDownload Links:\n\n`;
                allLinks.forEach((l, i) => { lt += `${i + 1}. ${l.fileName}\n`; });
                lt += `\n\nCommands:\n.si all - all parts to inbox\n.sg [group] all - all parts to group\n.si [number] - from that number\n.sg [group] [number] - from that number to group\n\nPOWERED BY RV Games`;

                session.selectedGame = selectedGame;
                session.links = allLinks;
                fitgirlSessions.set(chatJid, session);
                await sock.sendMessage(chatJid, { text: lt, edit: linkMsg.key });

            } catch (error) {
                console.error('.fg links error:', error);
                await sock.sendMessage(chatJid, { text: `Links error: ${error.message}`, edit: linkMsg.key });
            }
        }

        // .si all
        else if (text.trim() === '.si all') {
            const session = fitgirlSessions.get(chatJid);
            if (!session || !session.links || session.links.length === 0) {
                return await sock.sendMessage(chatJid, { text: 'Please select a game first with .fg [game name]' }, { quoted: msg });
            }

            const startTime = Date.now();
            let uploadedCount = 0, failedCount = 0, wasStopped = false;
            const totalParts = session.links.length;

            const initialNotify = await sock.sendMessage(chatJid, { text: `Sending all ${totalParts} parts to inbox...` });

            for (let i = 0; i < session.links.length; i++) {
                const linkObj = session.links[i];
                console.log(`[DL] Part ${i + 1}/${totalParts}: ${linkObj.fileName}`);
                const realUrl = await resolveFuckingFast(linkObj.url);
                if (!realUrl) { console.log(`[DL] Failed to resolve`); failedCount++; continue; }
                const success = await handleDownloadAndUpload(realUrl, sock, msg, senderJid, linkObj.fileName);
                if (success === 'STOPPED') { wasStopped = true; break; }
                if (success) uploadedCount++;
            }

            const endTime = Date.now();
            const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

            if (uploadedCount > 0 && !wasStopped) {
                const st = `RV GAMES\n\nStatus: Done\nTotal Parts: ${uploadedCount}\nFailed: ${failedCount}\nTime: ${totalTimeSeconds}s\n\nPOWERED BY RV Games`;
                await sock.sendMessage(chatJid, { text: st });
                await sock.sendMessage(chatJid, { text: `All ${uploadedCount} parts sent to inbox!`, edit: initialNotify.key });
            } else if (wasStopped) {
                await sock.sendMessage(chatJid, { text: `Process stopped.`, edit: initialNotify.key });
            }
        }

        // .sg [group] all
        else if (text.match(/^\.sg\s+.+\s+all$/i)) {
            const session = fitgirlSessions.get(chatJid);
            if (!session || !session.links || session.links.length === 0) {
                return await sock.sendMessage(chatJid, { text: 'Please select a game first with .fg [game name]' }, { quoted: msg });
            }

            const groupName = text.replace('.sg ', '').replace(/\s+all$/i, '').trim().toLowerCase();
            const initialNotify = await sock.sendMessage(chatJid, { text: `Searching for group '${groupName}'...` });

            try {
                const groups = await sock.groupFetchAllParticipating();
                let targetGroupJid = null;
                for (let jid in groups) {
                    if (groups[jid].subject.toLowerCase().includes(groupName)) { targetGroupJid = jid; break; }
                }
                if (!targetGroupJid) return await sock.sendMessage(chatJid, { text: 'Group not found.' });

                const startTime = Date.now();
                let uploadedCount = 0, failedCount = 0, wasStopped = false;
                const totalParts = session.links.length;

                await sock.sendMessage(chatJid, { text: `Sending all ${totalParts} parts to ${groups[targetGroupJid].subject}...`, edit: initialNotify.key });

                for (let i = 0; i < session.links.length; i++) {
                    const linkObj = session.links[i];
                    const realUrl = await resolveFuckingFast(linkObj.url);
                    if (!realUrl) { failedCount++; continue; }
                    const success = await handleDownloadAndUpload(realUrl, sock, msg, targetGroupJid, linkObj.fileName);
                    if (success === 'STOPPED') { wasStopped = true; break; }
                    if (success) uploadedCount++;
                }

                const endTime = Date.now();
                const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

                if (uploadedCount > 0 && !wasStopped) {
                    const st = `RV GAMES\n\nStatus: Done\nTotal Parts: ${uploadedCount}\nFailed: ${failedCount}\nTime: ${totalTimeSeconds}s\n\nPOWERED BY RV Games`;
                    await sock.sendMessage(targetGroupJid, { text: st });
                    await sock.sendMessage(chatJid, { text: `All ${uploadedCount} parts sent to group!`, edit: initialNotify.key });
                } else if (wasStopped) {
                    await sock.sendMessage(chatJid, { text: `Process stopped.`, edit: initialNotify.key });
                }
            } catch (error) {
                await sock.sendMessage(chatJid, { text: 'Error sending to group.' });
            }
        }

        // .si [number]
        else if (text.match(/^\.si\s+\d+$/)) {
            const partNum = parseInt(text.replace('.si ', '').trim());
            const session = fitgirlSessions.get(chatJid);
            if (!session || !session.links || session.links.length === 0) {
                return await sock.sendMessage(chatJid, { text: 'Please select a game first.' }, { quoted: msg });
            }
            if (partNum < 1 || partNum > session.links.length) {
                return await sock.sendMessage(chatJid, { text: `Number must be between 1 and ${session.links.length}.` });
            }

            const startTime = Date.now();
            let uploadedCount = 0, failedCount = 0, wasStopped = false;
            const linksToDownload = session.links.slice(partNum - 1);
            const initialNotify = await sock.sendMessage(chatJid, { text: `Sending parts ${partNum} to ${session.links.length} to inbox...` });

            for (let i = 0; i < linksToDownload.length; i++) {
                const linkObj = linksToDownload[i];
                const realUrl = await resolveFuckingFast(linkObj.url);
                if (!realUrl) { failedCount++; continue; }
                const success = await handleDownloadAndUpload(realUrl, sock, msg, senderJid, linkObj.fileName);
                if (success === 'STOPPED') { wasStopped = true; break; }
                if (success) uploadedCount++;
            }

            const endTime = Date.now();
            const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

            if (uploadedCount > 0 && !wasStopped) {
                const st = `RV GAMES\n\nStatus: Done\nTotal Parts: ${uploadedCount}\nFailed: ${failedCount}\nTime: ${totalTimeSeconds}s\n\nPOWERED BY RV Games`;
                await sock.sendMessage(chatJid, { text: st });
                await sock.sendMessage(chatJid, { text: `${uploadedCount} parts sent to inbox!`, edit: initialNotify.key });
            } else if (wasStopped) {
                await sock.sendMessage(chatJid, { text: `Process stopped.`, edit: initialNotify.key });
            }
        }

        // .sg [group] [number]
        else if (text.match(/^\.sg\s+.+\s+\d+$/)) {
            const match = text.match(/^\.sg\s+(.+)\s+(\d+)$/);
            if (!match) return;
            const groupName = match[1].trim().toLowerCase();
            const partNum = parseInt(match[2]);

            const session = fitgirlSessions.get(chatJid);
            if (!session || !session.links || session.links.length === 0) {
                return await sock.sendMessage(chatJid, { text: 'Please select a game first.' }, { quoted: msg });
            }
            if (partNum < 1 || partNum > session.links.length) {
                return await sock.sendMessage(chatJid, { text: `Number must be between 1 and ${session.links.length}.` });
            }

            const initialNotify = await sock.sendMessage(chatJid, { text: `Searching for group '${groupName}'...` });

            try {
                const groups = await sock.groupFetchAllParticipating();
                let targetGroupJid = null;
                for (let jid in groups) {
                    if (groups[jid].subject.toLowerCase().includes(groupName)) { targetGroupJid = jid; break; }
                }
                if (!targetGroupJid) return await sock.sendMessage(chatJid, { text: 'Group not found.' });

                const startTime = Date.now();
                let uploadedCount = 0, failedCount = 0, wasStopped = false;
                const linksToDownload = session.links.slice(partNum - 1);

                await sock.sendMessage(chatJid, { text: `Sending parts ${partNum} to ${session.links.length} to ${groups[targetGroupJid].subject}...`, edit: initialNotify.key });

                for (let i = 0; i < linksToDownload.length; i++) {
                    const linkObj = linksToDownload[i];
                    const realUrl = await resolveFuckingFast(linkObj.url);
                    if (!realUrl) { failedCount++; continue; }
                    const success = await handleDownloadAndUpload(realUrl, sock, msg, targetGroupJid, linkObj.fileName);
                    if (success === 'STOPPED') { wasStopped = true; break; }
                    if (success) uploadedCount++;
                }

                const endTime = Date.now();
                const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

                if (uploadedCount > 0 && !wasStopped) {
                    const st = `RV GAMES\n\nStatus: Done\nTotal Parts: ${uploadedCount}\nFailed: ${failedCount}\nTime: ${totalTimeSeconds}s\n\nPOWERED BY RV Games`;
                    await sock.sendMessage(targetGroupJid, { text: st });
                    await sock.sendMessage(chatJid, { text: `${uploadedCount} parts sent to group!`, edit: initialNotify.key });
                } else if (wasStopped) {
                    await sock.sendMessage(chatJid, { text: `Process stopped.`, edit: initialNotify.key });
                }
            } catch (error) {
                await sock.sendMessage(chatJid, { text: 'Error sending to group.' });
            }
        }

        // .si (Direct URL)
        else if (text.startsWith('.si ') && !text.match(/^\.si\s+\d+$/) && text.trim() !== '.si all') {
            if (urls.length === 0) return await sock.sendMessage(msg.key.remoteJid, { text: 'Please provide a valid link.' }, { quoted: msg });
            for (let url of urls) {
                const res = await handleDownloadAndUpload(url, sock, msg, senderJid);
                if (res === 'STOPPED') break; 
            }
        }

        // .sg (Direct URL)
        else if (text.startsWith('.sg ') && !text.match(/^\.sg\s+.+\s+all$/i) && !text.match(/^\.sg\s+.+\s+\d+$/)) {
            if (urls.length === 0) return await sock.sendMessage(msg.key.remoteJid, { text: 'Please provide a valid link.' }, { quoted: msg });

            let groupName = text.replace('.sg ', '');
            urls.forEach(u => groupName = groupName.replace(u, ''));
            groupName = groupName.trim().toLowerCase();

            if (!groupName) return await sock.sendMessage(msg.key.remoteJid, { text: 'Please provide a group name.' }, { quoted: msg });
            const initialNotify = await sock.sendMessage(msg.key.remoteJid, { text: `Searching for group '${groupName}'...` });

            try {
                const groups = await sock.groupFetchAllParticipating();
                let targetGroupJid = null;
                for (let jid in groups) {
                    if (groups[jid].subject.toLowerCase().includes(groupName)) { targetGroupJid = jid; break; }
                }
                if (!targetGroupJid) return await sock.sendMessage(msg.key.remoteJid, { text: 'Group not found.' });

                const startTime = Date.now();
                let uploadedCount = 0, wasStopped = false;
                for (let url of urls) {
                    const success = await handleDownloadAndUpload(url, sock, msg, targetGroupJid);
                    if (success === 'STOPPED') { wasStopped = true; break; }
                    if (success) uploadedCount++;
                }
                const endTime = Date.now();
                const totalTimeSeconds = ((endTime - startTime) / 1000).toFixed(1);

                if (uploadedCount > 0 && !wasStopped) {
                    const st = `RV GAMES\n\nStatus: Done\nTotal Parts: ${uploadedCount}\nTime: ${totalTimeSeconds}s\n\nPOWERED BY RV Games`;
                    await sock.sendMessage(targetGroupJid, { text: st });
                    await sock.sendMessage(msg.key.remoteJid, { text: `All ${uploadedCount} parts sent to group!`, edit: initialNotify.key });
                } else if (wasStopped) {
                    await sock.sendMessage(msg.key.remoteJid, { text: `Process stopped.`, edit: initialNotify.key });
                }
            } catch (error) {
                await sock.sendMessage(msg.key.remoteJid, { text: 'Error sending to group.' });
            }
        }

        // .stop
        else if (text.trim().startsWith('.stop')) { 
            if (activeTasks.has(chatJid)) {
                const task = activeTasks.get(chatJid);
                task.controller.abort();
                if (task.uploadInterval) clearInterval(task.uploadInterval);
                if (task.stream) { try { task.stream.destroy(); } catch(e){} } 
                if (task.writer) { try { task.writer.destroy(); } catch(e){} }
                if (task.progressMsgKey) {
                    const st = `RV GAMES\n\nStatus: Process Stopped!\n\nPOWERED BY RV Games`;
                    await sock.sendMessage(chatJid, { text: st, edit: task.progressMsgKey }).catch(() => {});
                }
                setTimeout(() => {
                    if (task.tempFilePath && fs.existsSync(task.tempFilePath)) { try { fs.unlinkSync(task.tempFilePath); } catch (e) {} }
                }, 1000);
                activeTasks.delete(chatJid);
                await sock.sendMessage(chatJid, { text: 'All active downloads stopped and data cleared!' }, { quoted: msg });
            } else {
                await sock.sendMessage(chatJid, { text: 'No active downloads.' }, { quoted: msg });
            }
        }

        // .speed
        else if (text.trim() === '.speed') {
            await sock.sendMessage(msg.key.remoteJid, { text: 'Testing server speed...' }, { quoted: msg });
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
                await axios.post('https://httpbin.org/post', payload, { headers: { 'Content-Type': 'text/plain' } });
                const ulEnd = Date.now();
                const ulDuration = (ulEnd - ulStart) / 1000;
                const uploadSpeed = (8 / ulDuration).toFixed(2);

                const st = `RV GAMES SERVER SPEED\n\nPing: ${pingTime} ms\nDownload: ${downloadSpeed} Mbps\nUpload: ${uploadSpeed} Mbps\n\nPOWERED BY RV Games`;
                await sock.sendMessage(msg.key.remoteJid, { text: st }, { quoted: msg });
            } catch (error) {
                console.error("Speed test error:", error.message);
                await sock.sendMessage(msg.key.remoteJid, { text: `Speed test error: ${error.message}` }, { quoted: msg });
            }
        }

        // .dc
        else if (text.trim() === '.dc') {
            await sock.sendMessage(msg.key.remoteJid, { text: 'Cleaning temp files...' }, { quoted: msg });
            try {
                const directory = './';
                const files = fs.readdirSync(directory);
                let deletedCount = 0, freedSpace = 0;
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
                const ct = `RV GAMES DISK CLEANER\n\nStatus: Done\nRemoved: ${deletedCount} files\nFreed: ${freedMB} MB\n\nPOWERED BY RV Games`;
                await sock.sendMessage(msg.key.remoteJid, { text: ct }, { quoted: msg });
            } catch (error) {
                console.error("Disk cleaner error:", error.message);
                await sock.sendMessage(msg.key.remoteJid, { text: `Error: ${error.message}` }, { quoted: msg });
            }
        }

        // .crash
        else if (text.trim() === '.crash') {
            await sock.sendMessage(msg.key.remoteJid, { text: 'RV Games Bot is shutting down...' }, { quoted: msg });
            console.log("Manual crash triggered.");
            setTimeout(() => { process.exit(0); }, 1000);
        }

        // .menu
        else if (text.trim() === '.menu') {
            const menuText = 
                `RV GAMES OFFICIAL BOT\n\n` +
                `MAIN COMMANDS:\n` +
                `.fg [game name] - Search FitGirl\n` +
                `.si [link] - Download to inbox\n` +
                `.sg [group] [link] - Download to group\n` +
                `.stop - Stop all downloads\n` +
                `.speed - Server speed test\n` +
                `.dc - Clean disk\n` +
                `.menu - Show this menu\n\n` +
                `FitGirl Commands (after .fg):\n` +
                `.si all - All parts to inbox\n` +
                `.sg [group] all - All parts to group\n` +
                `.si [number] - From that number\n` +
                `.sg [group] [number] - From number to group\n\n` +
                `POWERED BY RV Games`;
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
            console.log('RV Games Bot Connected!');
        }
    });
}

startBot();
