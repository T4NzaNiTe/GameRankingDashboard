import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import gplay from 'google-play-scraper';
import * as cheerio from 'cheerio';

const SERVICE_ACCOUNT_FILE = './credentials.json';
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1ONFeWZTqMXIsWtx9xoRYxcW7lTde56yfvyKUXDi8c3c/edit?gid=1490331569#gid=1490331569';
const DASHBOARD_URL = 'https://2Khaz.github.io/game-rank-dashboard/';

const spreadsheetId = SPREADSHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];

async function fetchSteamGlobal() {
    console.log("스팀(전체) 최고 매출 데이터 가져오는 중...");
    try {
        const res = await fetch("https://store.steampowered.com/search/results/?query&start=0&count=100&filter=topsellers&infinite=1");
        const data = await res.json();
        const $ = cheerio.load(data.results_html);
        
        const games = [];
        $('a.search_result_row').each((i, el) => {
            const title = $(el).find('.title').text().trim();
            const appIdRaw = $(el).attr('data-ds-appid');
            const appId = appIdRaw ? appIdRaw.split(',')[0] : null;
            games.push({
                name: title,
                appId: appId,
                developer: '-'
            });
        });
        
        console.log("스팀 개발사 정보 추가 중 (약 10~15초 소요)...");
        const batchSize = 10;
        for (let i = 0; i < Math.min(100, games.length); i += batchSize) {
            const batch = games.slice(i, i + batchSize);
            await Promise.all(batch.map(async (game) => {
                if (game.appId) {
                    try {
                        const appRes = await fetch(`https://store.steampowered.com/api/appdetails?appids=${game.appId}`);
                        const appData = await appRes.json();
                        if (appData && appData[game.appId] && appData[game.appId].success) {
                            const devs = appData[game.appId].data.developers;
                            if (devs && devs.length > 0) {
                                game.developer = devs[0];
                            }
                        }
                    } catch (err) {}
                }
            }));
            // 스팀 API Rate Limit 방지를 위한 약간의 대기
            await new Promise(r => setTimeout(r, 500));
        }
        
        return games.slice(0, 100);
    } catch (e) {
        console.error("스팀 데이터 오류:", e);
        return [];
    }
}

async function fetchPlayStore(country = 'us', lang = 'en') {
    console.log(`구글 플레이스토어(${country}) 최고 매출 데이터 가져오는 중...`);
    try {
        const data = await gplay.list({
            collection: gplay.collection.GROSSING, // 정확한 최고 매출 컬렉션 값 사용
            category: gplay.category.GAME,
            num: 100,
            country: country,
            lang: lang
        });
        return data;
    } catch (e) {
        console.error(`구글 플레이 데이터 오류 (${country}):`, e.message);
        return [];
    }
}

async function main() {
    const credsRaw = fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8');
    const creds = JSON.parse(credsRaw);

    const jwt = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file'
        ]
    });

    const doc = new GoogleSpreadsheet(spreadsheetId, jwt);
    
    console.log("구글 시트 접속 중...");
    await doc.loadInfo(); 
    console.log(`문서 로드됨: ${doc.title}`);

    const [steamGlobal, playKr] = await Promise.all([
        fetchSteamGlobal(),
        fetchPlayStore('kr', 'ko')
    ]);

    const now = new Date();
    const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const nowStr = kst.toISOString().replace(/T/, ' ').substring(0, 13);
    
    let sheet;
    try {
        sheet = doc.sheetsByTitle[nowStr];
        if (sheet) {
            await sheet.delete();
        }
    } catch(e) {}

    console.log(`'${nowStr}' 이름의 새 시트 생성 중...`);
    // 2개 영역이므로 105 rows, 10 columns 정도면 충분 (A~G)
    sheet = await doc.addSheet({ title: nowStr, gridProperties: { rowCount: 105, columnCount: 10 } });
    
    await sheet.loadCells('A1:H102');

    const headers = [
        "순위", "스팀(전체) 게임명", "스팀(전체) 개발사", "",
        "순위", "구글(한국) 게임명", "구글(한국) 개발사"
    ];

    // Row 0 (A1) = Link
    const a1 = sheet.getCell(0, 0);
    a1.formula = `=HYPERLINK("${DASHBOARD_URL}", "🖥️ 웹 대시보드 열기")`;
    a1.textFormat = { bold: true, fontSize: 12 };
    a1.backgroundColor = { red: 0.8, green: 0.9, blue: 1.0 };

    // Row 1 (Headers)
    for(let c=0; c<headers.length; c++) {
        const cell = sheet.getCell(1, c);
        cell.value = headers[c];
        cell.textFormat = { bold: true };
        cell.backgroundColor = { red: 0.9, green: 0.9, blue: 0.9 };
    }

    // Row 2~101 (Data)
    for (let i = 0; i < 100; i++) {
        const rowIdx = i + 2;
        
        // Steam Global (A-C)
        if (i < steamGlobal.length) {
            sheet.getCell(rowIdx, 0).value = i + 1;
            sheet.getCell(rowIdx, 1).value = steamGlobal[i].name || '';
            sheet.getCell(rowIdx, 2).value = steamGlobal[i].developer || '';
        }
        
        // Play KR (E-G)
        if (i < playKr.length) {
            sheet.getCell(rowIdx, 4).value = i + 1;
            sheet.getCell(rowIdx, 5).value = playKr[i].title || '';
            sheet.getCell(rowIdx, 6).value = playKr[i].developer || '';
        }
    }

    console.log("데이터를 구글 시트에 기록하는 중...");
    await sheet.saveUpdatedCells();

    // Save data locally for dashboard
    const dashboardData = {
        lastUpdated: nowStr,
        steamGlobal: steamGlobal,
        playKr: playKr
    };
    fs.writeFileSync('data.json', JSON.stringify(dashboardData, null, 2), 'utf8');
    console.log("로컬 대시보드용 data.json 저장 완료!");

    console.log("완료되었습니다!");
}

main().catch(console.error);
