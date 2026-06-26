import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import gplay from 'google-play-scraper';
import * as cheerio from 'cheerio';

const SERVICE_ACCOUNT_FILE = './credentials.json';
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1ONFeWZTqMXIsWtx9xoRYxcW7lTde56yfvyKUXDi8c3c/edit?gid=1490331569#gid=1490331569';
const spreadsheetId = SPREADSHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

async function fetchSteamGlobal(retries = 3) {
    console.log("스팀(한국) 최고 매출 데이터 가져오는 중..");
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch("https://store.steampowered.com/search/results/?query&start=0&count=100&filter=topsellers&infinite=1&cc=kr&l=koreana", {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Cookie': 'birthtime=283993201; lastagecheckage=1-January-1980; wants_mature_content=1; mature_content=1'
                }
            });
            const data = await res.json();
            const $ = cheerio.load(data.results_html);
            
            const games = [];
            $('a.search_result_row').each((i, el) => {
                const title = $(el).find('.title').text().trim();
                const appIdRaw = $(el).attr('data-ds-appid');
                const appId = appIdRaw ? appIdRaw.split(',')[0] : null;
                games.push({ name: title, appId: appId, developer: '-', genre: '기본', price: null });
            });

            if (games.length === 0) throw new Error("스팀 데이터가 0건입니다.");
            
            console.log(`[Steam] 데이터 ${games.length}건 성공! 개발사/장르/가격 정보 추가 중(약 10~15초 소요)...`);
            const batchSize = 10;
            for (let i = 0; i < Math.min(100, games.length); i += batchSize) {
                const batch = games.slice(i, i + batchSize);
                await Promise.all(batch.map(async (game) => {
                    if (game.appId) {
                        try {
                            const appRes = await fetch(`https://store.steampowered.com/api/appdetails?appids=${game.appId}&cc=kr&l=koreana`, {
                                headers: { 
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                    'Cookie': 'birthtime=283993201; lastagecheckage=1-January-1980; wants_mature_content=1; mature_content=1'
                                }
                            });
                            const appData = await appRes.json();
                            if (appData && appData[game.appId] && appData[game.appId].success) {
                                const detail = appData[game.appId].data;
                                const devs = detail.developers;
                                if (devs && devs.length > 0) game.developer = devs[0];
                                const genres = detail.genres;
                                if (genres && genres.length > 0) game.genre = genres[0].description;
                                if (detail.header_image) game.icon = detail.header_image;

                                if (detail.is_free) {
                                    game.price = { final: '무료 (Free)', isFree: true, isDiscounted: false };
                                } else if (detail.price_overview) {
                                    game.price = {
                                        final: detail.price_overview.final_formatted,
                                        isFree: false,
                                        isDiscounted: detail.price_overview.discount_percent > 0,
                                        discountPercent: detail.price_overview.discount_percent,
                                        initial: detail.price_overview.initial_formatted
                                    };
                                }
                            }
                        } catch(e) {}
                    }
                }));
                await delay(1500); 
            }
            return games.slice(0, 100);
        } catch (error) {
            console.error(`[Steam] 데이터 로드 실패 (시도 ${attempt}/${retries}):`, error.message);
            if (attempt < retries) await delay(3000);
        }
    }
    console.error("[Steam] 모든 재시도 실패.");
    return [];
}

async function fetchPlayStore(country, lang, retries = 3) {
    console.log(`구글 플레이스토어(${country}) 최고 매출 데이터 가져오는 중..`);
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const results = await gplay.list({
                collection: gplay.sort.GROSSING,
                category: gplay.category.GAME,
                num: 100,
                country: country,
                lang: lang
            });
            if (results.length === 0) throw new Error("데이터가 0건입니다.");
            
            console.log(`[PlayStore] 데이터 ${results.length}건 성공! 장르 정보 추가 중(약 10~15초 소요)...`);
            const batchSize = 10;
            for (let i = 0; i < Math.min(100, results.length); i += batchSize) {
                const batch = results.slice(i, i + batchSize);
                await Promise.all(batch.map(async (game) => {
                    try {
                        const detail = await gplay.app({ appId: game.appId, country: country, lang: lang });
                        if (detail.genre) game.genre = detail.genre;
                    } catch(e) { }
                }));
                await delay(1000);
            }
            return results;
        } catch (error) {
            console.error(`[PlayStore] 데이터 로드 실패 (시도 ${attempt}/${retries}):`, error.message);
            if (attempt < retries) await delay(3000);
        }
    }
    console.error("[PlayStore] 모든 재시도 실패.");
    return [];
}

function calculateRankChange(currentList, previousList, matchKey) {
    if (!previousList || previousList.length === 0) return currentList;
    return currentList.map((item, index) => {
        const currentRank = index + 1;
        const prevItemIndex = previousList.findIndex(p => p[matchKey] === item[matchKey]);
        if (prevItemIndex !== -1) {
            const prevRank = prevItemIndex + 1;
            item.rankChange = prevRank - currentRank; 
        } else {
            item.rankChange = 'NEW';
        }
        return item;
    });
}

function calculateStreaks(currentList, platformKey, matchKey, streaksObj) {
    const todayTop10 = currentList.slice(0, 10).map(item => item[matchKey]);
    
    for (const id in streaksObj) {
        if (streaksObj[id].platform === platformKey) {
            if (!todayTop10.includes(id)) {
                streaksObj[id].count = 0; 
            }
        }
    }
    
    currentList.slice(0, 10).forEach(item => {
        const id = item[matchKey];
        if (!streaksObj[id]) {
            streaksObj[id] = { count: 1, name: item.title || item.name, platform: platformKey };
        } else {
            streaksObj[id].count += 1;
        }
        item.streak = streaksObj[id].count;
    });
}

function enrichDataWithRankAndStreak(currentList, platformKey, previousList, streaksObj) {
    const matchKey = platformKey === 'steam' ? 'appId' : 'appId';
    calculateRankChange(currentList, previousList, matchKey);
    calculateStreaks(currentList, platformKey, matchKey, streaksObj);
}

function cleanupStreaks(steamGlobal, playKr, streaksObj) {
    const allCurrentIds = new Set([
        ...steamGlobal.slice(0, 10).map(g => g.appId),
        ...playKr.slice(0, 10).map(g => g.appId)
    ]);
    for (const id in streaksObj) {
        if (!allCurrentIds.has(id) && streaksObj[id].count === 0) {
            delete streaksObj[id];
        }
    }
}

async function writeToGoogleSheets(nowStr, steamGlobal, playKr, retries = 5) {
    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        console.error("❌ 치명적 오류: credentials.json 파일이 없습니다.");
        return false;
    }

    let creds;
    try {
        const credsRaw = fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8');
        creds = JSON.parse(credsRaw);
    } catch (e) {
        console.error("❌ 치명적 오류: credentials.json 파싱 실패:", e.message);
        return false;
    }

    const jwt = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
    });

    const doc = new GoogleSpreadsheet(spreadsheetId, jwt);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`구글 시트 접속 중... (시도 ${attempt}/${retries})`);
            await doc.loadInfo(); 
            const sheetTitle = nowStr; // 기존 형식 유지 (예: 2026-06-26 10)
            let sheet = doc.sheetsByTitle[sheetTitle];
            if (!sheet) {
                console.log(`'${sheetTitle}' 이름의 새 시트 생성 중...`);
                // 기본적으로 맨 끝에 생성되며 기존 그리드 속성 유지
                sheet = await doc.addSheet({ 
                    title: sheetTitle, 
                    headerValues: ['스팀순위', '스팀게임명', '스팀제작사', '플레이스토어순위', '플레이게임명', '플레이제작사'],
                    gridProperties: { rowCount: 105, columnCount: 10 } 
                });
            }

            await sheet.loadCells('A2:F101');
            for(let c=0; c<6; c++) {
                for(let r=1; r<=100; r++) {
                    const cell = sheet.getCell(r, c);
                    if (cell.value !== null && cell.value !== '') cell.value = '';
                }
            }

            const maxRows = Math.max(steamGlobal.length, playKr.length);
            for (let i = 0; i < maxRows; i++) {
                const rowIdx = i + 1; 
                if (i < steamGlobal.length) {
                    sheet.getCell(rowIdx, 0).value = i + 1;
                    sheet.getCell(rowIdx, 1).value = steamGlobal[i].name || '';
                    sheet.getCell(rowIdx, 2).value = steamGlobal[i].publisher || '';
                }
                if (i < playKr.length) {
                    sheet.getCell(rowIdx, 4).value = i + 1;
                    sheet.getCell(rowIdx, 5).value = playKr[i].title || '';
                    sheet.getCell(rowIdx, 6).value = playKr[i].developer || '';
                }
            }

            console.log("데이터를 구글 시트에 기록하는 중...");
            await sheet.saveUpdatedCells();
            console.log("✅ 구글 시트 저장 완료!");
            return true;
        } catch (e) {
            console.error(`[Google Sheets] 저장 실패 (시도 ${attempt}/${retries}):`, e.message);
            await sendDiscordAlert(`🚨 **[Google Sheets] 기록 오류!**\n\`${e.message}\`\n30초 후 재시도합니다...`);
            if (attempt < retries) await delay(30000);
        }
    }
    console.error("❌ 구글 시트 저장 최종 실패. 데이터를 임시 보관함에 저장합니다.");
    return false;
}

async function saveHistory(nowStr, steamGlobal, playKr) {
    const historyDir = path.join(process.cwd(), 'history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir);

    const dateStr = nowStr.substring(0, 10) + '_' + nowStr.substring(11, 13);
    const historyFile = path.join(historyDir, `${dateStr}.json`);
    const historyData = {
        timestamp: nowStr,
        steamGlobal: steamGlobal,
        playKr: playKr
    };
    fs.writeFileSync(historyFile, JSON.stringify(historyData, null, 2), 'utf8');

    const listFile = path.join(historyDir, 'history_list.json');
    let historyList = [];
    if (fs.existsSync(listFile)) {
        try { historyList = JSON.parse(fs.readFileSync(listFile, 'utf8')); } catch(e) {}
    }
    if (!historyList.includes(dateStr)) {
        historyList.unshift(dateStr);
        fs.writeFileSync(listFile, JSON.stringify(historyList, null, 2), 'utf8');
    }

    const dataFile = path.join(process.cwd(), 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify(historyData, null, 2), 'utf8');
    console.log(`✅ 대시보드 데이터 저장 완료! (data.json 및 history/${dateStr}.json)`);
}

async function sendDiscordAlert(message) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message })
        });
    } catch (e) {
        console.error("디스코드 알림 전송 실패:", e.message);
    }
}

async function main() {
    const now = new Date();
    const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const nowStr = kst.toISOString().replace(/T/, ' ').substring(0, 13);

    const [steamGlobal, playKr] = await Promise.all([
        fetchSteamGlobal(3),
        fetchPlayStore('kr', 'ko', 3)
    ]);

    const historyDir = path.join(process.cwd(), 'history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir);

    let previousSteam = [];
    let previousPlay = [];
    
    const listFile = path.join(historyDir, 'history_list.json');
    if (fs.existsSync(listFile)) {
        try {
            const historyList = JSON.parse(fs.readFileSync(listFile, 'utf8'));
            if (historyList.length > 0) {
                const lastHistoryName = historyList[0];
                const lastHistoryFile = path.join(historyDir, `${lastHistoryName}.json`);
                if (fs.existsSync(lastHistoryFile)) {
                    const lastData = JSON.parse(fs.readFileSync(lastHistoryFile, 'utf8'));
                    previousSteam = lastData.steamGlobal || [];
                    previousPlay = lastData.playKr || [];
                }
            }
        } catch(e) {}
    }

    const streaksFile = path.join(historyDir, 'game_streaks.json');
    let streaks = {};
    if (fs.existsSync(streaksFile)) {
        try { streaks = JSON.parse(fs.readFileSync(streaksFile, 'utf8')); } catch(e) {}
    }

    enrichDataWithRankAndStreak(steamGlobal, 'steam', previousSteam, streaks);
    enrichDataWithRankAndStreak(playKr, 'play', previousPlay, streaks);
    cleanupStreaks(steamGlobal, playKr, streaks);

    // 1. 구글 시트 저장 시도 (성공 여부를 먼저 판별)
    const isSheetSuccess = await writeToGoogleSheets(nowStr, steamGlobal, playKr, 5);

    // 2. 구글 시트 저장 실패 시 큐(pending_sheets.json)에 저장 후 대시보드 업데이트 계속 진행
    if (!isSheetSuccess) {
        const pendingFile = path.join(process.cwd(), 'pending_sheets.json');
        let pendingQueue = [];
        if (fs.existsSync(pendingFile)) {
            try { pendingQueue = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch(e) {}
        }
        
        // 데이터 누적을 방지하기 위해 보관함 최대 크기 10개로 제한 (Poison Pill 방지)
        if (pendingQueue.length >= 10) {
            pendingQueue.shift(); // 가장 오래된 데이터 버리기
        }
        
        pendingQueue.push({
            timestamp: nowStr,
            steamGlobal: steamGlobal,
            playKr: playKr
        });
        fs.writeFileSync(pendingFile, JSON.stringify(pendingQueue, null, 2), 'utf8');

        await sendDiscordAlert(`🚨 **크롤링 부분 성공 (구글 시트 실패)**\n시간: \`${nowStr}\`\n구글 시트 저장에 실패하여 임시 보관함에 저장했습니다. 몇 시간 뒤 자동 재시도됩니다.`);
        console.error("❌ 구글 시트 저장 실패. 데이터를 임시 보관함에 저장하고 대시보드 업데이트를 진행합니다.");
    }

    // 3. 시트 저장 여부와 무관하게 streaks 데이터와 로컬 히스토리 파일 덮어쓰기
    fs.writeFileSync(streaksFile, JSON.stringify(streaks, null, 2), 'utf8');
    await saveHistory(nowStr, steamGlobal, playKr);

    // 4. 최종 성공 알림 (시트 성공 시에만)
    if (isSheetSuccess) {
        await sendDiscordAlert(`✅ **크롤링 완벽 성공!**\n시간: \`${nowStr}\`\n구글 시트 및 웹 대시보드 데이터 저장이 모두 무사히 완료되었습니다.`);
    }
    console.log("✅ 모든 크롤링 프로세스가 완료되었습니다!");
}

main().catch(console.error);
