const axios = require('axios');
const cheerio = require('cheerio');
const gplay = require('google-play-scraper');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const fs = require('fs');
const path = require('path');
const credentials = require('./credentials.json');

const SHEET_ID = '1QhP3tH3c2w7Zt2O9-lB0iZ1q7S_c45iHl38W30T77e8'; 

async function fetchSteamGlobal() {
    let results = [];
    let start = 0;
    const count = 100;
    
    try {
        const response = await axios.get(`https://store.steampowered.com/search/results?sort_by=Reviews_DESC&start=${start}&count=${count}&dynamic_data=&force_infinite=1&category1=998&hidef2p=1&ndl=1`, {
            headers: {
                'Cookie': 'wants_mature_content=1; mature_content=1; birthtime=283993201; lastagecheckage=1-January-1978'
            }
        });
        const $ = cheerio.load(response.data.results_html);

        const games = [];
        $('a.search_result_row').each((i, el) => {
            if (i >= 100) return false;
            games.push({
                rank: i + 1,
                id: $(el).attr('data-ds-appid'),
                title: $(el).find('.title').text().trim()
            });
        });

        // Batch requests (10 at a time) to prevent timeouts
        for (let i = 0; i < games.length; i += 10) {
            const batch = games.slice(i, i + 10);
            const batchPromises = batch.map(async (game) => {
                try {
                    const detailRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${game.id}&l=korean`, {
                        headers: {
                            'Cookie': 'wants_mature_content=1; mature_content=1; birthtime=283993201; lastagecheckage=1-January-1978'
                        }
                    });
                    const data = detailRes.data[game.id];
                    if (data && data.success) {
                        const detail = data.data;
                        game.developer = detail.developers ? detail.developers.join(', ') : 'Unknown';
                    } else {
                        game.developer = 'Unknown';
                    }
                } catch (e) {
                    game.developer = 'Unknown';
                }
                return game;
            });

            const resolvedBatch = await Promise.all(batchPromises);
            results = results.concat(resolvedBatch);
            
            if (i + 10 < games.length) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }
        
        return results;
    } catch (e) {
        console.error('스팀 글로벌 유료게임 파싱 오류:', e);
        return [];
    }
}

async function fetchPlayStore() {
    try {
        const results = await gplay.list({
            category: gplay.category.GAME,
            collection: gplay.collection.TOP_PAID,
            num: 100,
            country: 'kr',
            lang: 'ko'
        });
        
        // 장르 가져오기 로직 추가
        const detailedResults = [];
        for (let i = 0; i < results.length; i += 10) {
            const batch = results.slice(i, i + 10);
            const batchPromises = batch.map(async (game, index) => {
                try {
                    const detail = await gplay.app({ appId: game.appId, country: 'kr', lang: 'ko' });
                    return {
                        rank: i + index + 1,
                        id: game.appId,
                        title: game.title,
                        developer: game.developer,
                        genre: detail.genre || 'Unknown'
                    };
                } catch(e) {
                    return {
                        rank: i + index + 1,
                        id: game.appId,
                        title: game.title,
                        developer: game.developer,
                        genre: 'Unknown'
                    };
                }
            });
            const resolvedBatch = await Promise.all(batchPromises);
            detailedResults.push(...resolvedBatch);
            
            if (i + 10 < results.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        return detailedResults;
    } catch (e) {
        console.error('플레이스토어 한국 유료게임 파싱 오류:', e);
        return [];
    }
}

function calculateRankChange(currentList, previousList) {
    if (!previousList || previousList.length === 0) return currentList.map(item => ({ ...item, rankChange: 'NEW' }));

    return currentList.map(currentItem => {
        const prevItem = previousList.find(p => p.id === currentItem.id);
        if (!prevItem) {
            return { ...currentItem, rankChange: 'NEW' };
        }
        const change = prevItem.rank - currentItem.rank;
        return { ...currentItem, rankChange: change };
    });
}

function calculateStreaks(currentList, previousStreaks, maxRank = 10) {
    const newStreaks = { ...previousStreaks };
    
    currentList.forEach(item => {
        if (item.rank <= maxRank) {
            if (newStreaks[item.id]) {
                newStreaks[item.id].daysInTop10 += 1;
            } else {
                newStreaks[item.id] = { daysInTop10: 1, title: item.title, platform: item.platform };
            }
        }
    });

    return newStreaks;
}

function cleanupStreaks(currentListSteam, currentListPlay, streaks, maxRank = 10) {
    const activeTop10Ids = new Set();
    currentListSteam.forEach(item => { if(item.rank <= maxRank) activeTop10Ids.add(item.id); });
    currentListPlay.forEach(item => { if(item.rank <= maxRank) activeTop10Ids.add(item.id); });

    const cleanedStreaks = {};
    for (const [id, data] of Object.entries(streaks)) {
        if (activeTop10Ids.has(id)) {
            cleanedStreaks[id] = data;
        }
    }
    return cleanedStreaks;
}

function enrichDataWithRankAndStreak(currentList, platform, previousList, streaks) {
    let listWithChange = calculateRankChange(currentList, previousList);
    return listWithChange.map(item => {
        const streakData = streaks[item.id];
        return {
            ...item,
            platform: platform,
            daysInTop10: streakData ? streakData.daysInTop10 : 0
        };
    });
}

const delay = ms => new Promise(res => setTimeout(res, ms));

async function sendDiscordAlert(message) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
        await axios.post(webhookUrl, { content: message });
    } catch (error) {
        console.error('Discord webhook 전송 실패:', error);
    }
}

async function writeToGoogleSheets(nowStr, steamGlobal, playKr, retries = 5) {
    const doc = new GoogleSpreadsheet(SHEET_ID);
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`구글 시트 접속 중... (시도 ${attempt}/${retries})`);
            await doc.useServiceAccountAuth(credentials);
            await doc.loadInfo(); 
            const sheetTitle = nowStr; // 2026-06-26 10 형식
            let sheet = doc.sheetsByTitle[sheetTitle];
            if (!sheet) {
                console.log(`'${sheetTitle}' 이름의 새 시트 생성 중...`);
                sheet = await doc.addSheet({ 
                    title: sheetTitle, 
                    headerValues: ['스팀순위', '스팀게임명', '스팀제작사', '플레이스토어순위', '플레이게임명', '플레이제작사'],
                    gridProperties: { rowCount: 105, columnCount: 10 } 
                });
            }

            await sheet.loadCells('A2:F101');
            
            const maxRows = Math.max(steamGlobal.length, playKr.length);
            
            for (let i = 0; i < maxRows; i++) {
                if (i < steamGlobal.length) {
                    sheet.getCell(i + 1, 0).value = steamGlobal[i].rank;
                    sheet.getCell(i + 1, 1).value = steamGlobal[i].title;
                    sheet.getCell(i + 1, 2).value = steamGlobal[i].developer;
                }
                
                if (i < playKr.length) {
                    sheet.getCell(i + 1, 3).value = playKr[i].rank;
                    sheet.getCell(i + 1, 4).value = playKr[i].title;
                    sheet.getCell(i + 1, 5).value = playKr[i].developer;
                }
            }
            
            await sheet.saveUpdatedCells();
            console.log('구글 시트 업데이트 완료!');
            return true; // 성공 시 탈출
            
        } catch (e) {
            console.error(`구글 시트 저장 실패 (시도 ${attempt}/${retries}):`, e.message);
            
            if (attempt === retries) {
                // 재시도 루프가 전부 끝났을 때만 최초 1회 에러 알람 전송
                await sendDiscordAlert(`🚨 **[Google Sheets] 기록 오류!**\n\`${e.message}\``);
            } else {
                console.log(`30초 후 재시도합니다...`);
                await delay(30000); // 30초 대기 후 재시도
            }
        }
    }
    return false; // 5번 모두 실패 시 false 반환
}

async function main() {
    const historyDir = path.join(process.cwd(), 'history');
    if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir);
    }
    
    let previousSteam = [];
    let previousPlay = [];
    let previousStreaks = {};
    const historyListFile = path.join(historyDir, 'history_list.json');
    const streaksFile = path.join(process.cwd(), 'game_streaks.json');

    if (fs.existsSync(historyListFile)) {
        try {
            const historyList = JSON.parse(fs.readFileSync(historyListFile, 'utf8'));
            if (historyList.length > 0) {
                const lastFile = path.join(historyDir, historyList[historyList.length - 1].file);
                if (fs.existsSync(lastFile)) {
                    const lastData = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
                    previousSteam = lastData.steamGlobal || [];
                    previousPlay = lastData.playKr || [];
                }
            }
        } catch (e) {}
    }

    if (fs.existsSync(streaksFile)) {
        try { previousStreaks = JSON.parse(fs.readFileSync(streaksFile, 'utf8')); } catch(e) {}
    }

    console.log('데이터 수집 시작...');
    const [steamGlobalRaw, playKrRaw] = await Promise.all([
        fetchSteamGlobal(),
        fetchPlayStore()
    ]);
    console.log('데이터 수집 완료!');

    const now = new Date();
    const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const nowStr = kst.toISOString().replace(/T/, ' ').substring(0, 13);
    const dateStr = nowStr.substring(0, 10) + '_' + nowStr.substring(11, 13);
    const historyFile = path.join(historyDir, `${dateStr}.json`);

    let currentStreaks = calculateStreaks(
        [...steamGlobalRaw.map(i=>({...i, platform:'steam'})), ...playKrRaw.map(i=>({...i, platform:'play'}))], 
        previousStreaks
    );
    currentStreaks = cleanupStreaks(steamGlobalRaw, playKrRaw, currentStreaks);

    const steamGlobal = enrichDataWithRankAndStreak(steamGlobalRaw, 'steam', previousSteam, currentStreaks);
    const playKr = enrichDataWithRankAndStreak(playKrRaw, 'play', previousPlay, currentStreaks);

    if (steamGlobal.length > 0 || playKr.length > 0) {
        // 구글 시트 작성 시도
        const isSheetSuccess = await writeToGoogleSheets(nowStr, steamGlobal, playKr, 5);

        if (!isSheetSuccess) {
            // 실패 시 대기열 큐(보관함)에 저장
            const pendingFile = path.join(process.cwd(), 'pending_sheets.json');
            let pendingQueue = [];
            if (fs.existsSync(pendingFile)) {
                try { pendingQueue = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch(e) {}
            }
            pendingQueue.push({
                timestamp: nowStr,
                steamGlobal,
                playKr
            });
            // 최대 10개(약 40시간치)까지만 보관하여 용량 방어 (가장 오래된 것 삭제)
            if (pendingQueue.length > 10) pendingQueue.shift();
            fs.writeFileSync(pendingFile, JSON.stringify(pendingQueue, null, 2), 'utf8');
            console.log(`구글 시트 저장 최종 실패. pending_sheets.json 보관함에 저장됨 (현재 대기열: ${pendingQueue.length}개)`);
            
            // 디스코드 부분 성공 (보관함 안내) 알림 발송
            await sendDiscordAlert(`🚨 **크롤링 부분 성공 (구글 시트 실패)**\n시간: ${nowStr}\n구글 시트 저장에 실패하여 임시 보관함에 저장했습니다. 몇 시간 뒤 자동 재시도됩니다.`);
        } else {
            // 성공 시 디스코드 알림
            await sendDiscordAlert(`✅ **크롤링 완벽 성공!**\n시간: ${nowStr}\n데이터 갱신 및 시트 저장이 완료되었습니다.`);
        }

        // 구글 시트 성공 여부와 관계없이 대시보드 JSON은 무조건 강제 업데이트
        const historyData = {
            timestamp: nowStr,
            steamGlobal,
            playKr
        };

        fs.writeFileSync(historyFile, JSON.stringify(historyData, null, 2), 'utf8');
        fs.writeFileSync(streaksFile, JSON.stringify(currentStreaks, null, 2), 'utf8');

        let historyList = [];
        if (fs.existsSync(historyListFile)) {
            try { historyList = JSON.parse(fs.readFileSync(historyListFile, 'utf8')); } catch(e) {}
        }
        
        if (!historyList.find(h => h.file === `${dateStr}.json`)) {
            historyList.push({
                timestamp: nowStr,
                file: `${dateStr}.json`
            });
            fs.writeFileSync(historyListFile, JSON.stringify(historyList, null, 2), 'utf8');
        }

        fs.writeFileSync(path.join(process.cwd(), 'data.json'), JSON.stringify(historyData, null, 2), 'utf8');
        console.log('로컬 데이터 저장(대시보드 업데이트) 완료!');
    } else {
        console.log('가져온 데이터가 없습니다.');
    }
}

main();
