import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import path from 'path';

const SERVICE_ACCOUNT_FILE = './credentials.json';
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1ONFeWZTqMXIsWtx9xoRYxcW7lTde56yfvyKUXDi8c3c/edit?gid=1490331569#gid=1490331569';
const DASHBOARD_URL = 'https://2Khaz.github.io/game-rank-dashboard/';
const spreadsheetId = SPREADSHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function writePendingData() {
    const pendingFile = path.join(process.cwd(), 'pending_sheets.json');
    if (!fs.existsSync(pendingFile)) {
        console.log("No pending data to process.");
        return;
    }

    let pendingQueue = [];
    try {
        pendingQueue = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } catch (e) {
        console.error("Failed to parse pending_sheets.json:", e.message);
        process.exit(1);
    }

    if (pendingQueue.length === 0) {
        console.log("Pending queue is empty. No Discord alert sent.");
        return;
    }

    console.log(`Found ${pendingQueue.length} pending items. Attempting to write to Google Sheets...`);

    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        console.error("credentials.json not found.");
        process.exit(1);
    }

    let creds;
    try {
        const credsRaw = fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8');
        creds = JSON.parse(credsRaw);
    } catch (e) {
        console.error("Failed to parse credentials.json (Check GCP_CREDENTIALS secret):", e.message);
        process.exit(1);
    }

    const jwt = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
    });

    const doc = new GoogleSpreadsheet(spreadsheetId, jwt);
    const retries = 5; // 메인 크롤러와 동일하게 최대 5회 재시도 설정
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`구글 시트 접속 중... (시도 ${attempt}/${retries})`);
            await doc.loadInfo();
            console.log(`문서 로드됨: ${doc.title}`);

            let successCount = 0;

            for (const item of pendingQueue) {
                const nowStr = item.timestamp; 
                let sheet;

                try {
                    try {
                        sheet = doc.sheetsByTitle[nowStr];
                        if (sheet) {
                            console.log(`[안내] 기존 '${nowStr}' 탭 발견. 삭제를 진행합니다.`);
                            await sheet.delete();
                            await delay(2000); // 탭 삭제 후 서버 캐시 갱신 대기
                        }
                    } catch(e) {
                        console.log(`[안내] 기존 탭 삭제 중 예외 발생 (무시하고 진행): ${e.message}`);
                    }

                    console.log(`[복구 중] '${nowStr}' 이름의 새 시트 탭 생성 중...`);
                    sheet = await doc.addSheet({
                        title: nowStr,
                        headerValues: [
                            '스팀 순위', '스팀 게임명', '스팀 가격', '스팀 개발사', '스팀 장르', '스팀 변동', '스팀 연속',
                            '구글 순위', '구글 게임명', '구글 가격', '구글 개발사', '구글 장르', '구글 변동', '구글 연속'
                        ]
                    });

                    await delay(2000);

                    const steamData = item.steamGlobal || [];
                    const googleData = item.googlePlay || [];
                    const maxLen = Math.max(steamData.length, googleData.length);
                    const rows = [];

                    for (let i = 0; i < maxLen; i++) {
                        const s = steamData[i] || {};
                        const g = googleData[i] || {};

                        let sPrice = "";
                        if (s.price) {
                            sPrice = s.price.isFree ? "무료" : (s.price.final || "");
                        }
                        let gPrice = "";
                        if (g.price) {
                            gPrice = g.price.isFree ? "무료" : (g.price.final || "");
                        }

                        rows.push({
                            '스팀 순위': s.name ? `${i + 1}` : '',
                            '스팀 게임명': s.name || '',
                            '스팀 가격': sPrice,
                            '스팀 개발사': s.developer || '',
                            '스팀 장르': s.genre || '',
                            '스팀 변동': s.name ? (s.rankChange || 0) : '',
                            '스팀 연속': s.name ? (s.streak || 1) : '',
                            '구글 순위': g.name ? `${i + 1}` : '',
                            '구글 게임명': g.name || '',
                            '구글 가격': gPrice,
                            '구글 개발사': g.developer || '',
                            '구글 장르': g.genre || '',
                            '구글 변동': g.name ? (g.rankChange || 0) : '',
                            '구글 연속': g.name ? (g.streak || 1) : ''
                        });
                    }

                    await sheet.addRows(rows);
                    console.log(`[성공] '${nowStr}' 탭에 ${rows.length}행 데이터 복구 완료.`);
                    successCount++;

                    await delay(2000);

                } catch (err) {
                    console.error(`[오류] '${nowStr}' 탭 복구 중 실패:`, err.message);
                }
            }

            // [시트 탭 오름차순 정렬 로직 (과거 ➔ 최신, 최신 탭 맨 우측)]
            if (successCount > 0) {
                try {
                    console.log("시트 탭 정렬(오름차순: 과거 -> 최신) 작업을 시작합니다...");
                    await doc.loadInfo(); 
                    
                    const sheets = doc.sheetCount ? [...doc.sheetsByIndex] : [];
                    const parsedSheets = sheets.map(s => {
                        const title = s.title;
                        const cleanTitle = title.length === 13 ? `${title}:00` : title;
                        const time = new Date(cleanTitle).getTime();
                        return { sheet: s, time: isNaN(time) ? 0 : time };
                    });

                    parsedSheets.sort((a, b) => a.time - b.time);

                    for (let i = 0; i < parsedSheets.length; i++) {
                        const currentSheet = parsedSheets[i].sheet;
                        if (currentSheet.index !== i) {
                            await currentSheet.updateProperties({ index: i });
                            await delay(1000);
                        }
                    }
                    console.log("시트 탭 오름차순 정렬 완료.");
                } catch (sortErr) {
                    console.error("시트 탭 정렬 중 오류 발생 (데이터는 유지됨):", sortErr.message);
                }
            }

            // [최종 청소 및 알림 조건 분기]
            if (successCount > 0) {
                fs.writeFileSync(pendingFile, '[]');
                console.log("Successfully wrote pending data and cleared local JSON.");
                await sendDiscordAlert(`✅ [구글 시트 누락 복구 완료] ${successCount}건의 대기 데이터가 복구되었습니다.`);
                return; // ◄◄ 정상 복구 및 정렬 완료 시 함수 완전 종료!
            } else {
                console.log("No items were successfully written in this attempt.");
                throw new Error("성공한 시트 복구 건수가 0건입니다."); // 재시도 루프로 넘김
            }

        } catch (e) {
            console.error(`[Google Sheets] 처리 실패 (시도 ${attempt}/${retries}):`, e.message);
            if (attempt < retries) {
                console.log("5초 대기 후 재시도합니다...");
                await delay(5000); // 5초 대기 후 소켓 재연결 시도
            }
        }
    }

    // 5회 모두 실패했을 때만 최종 에러 처리
    console.error("❌ 구글 시트 복구 최종 실패 (5회 시도 초과).");
    process.exit(1);
}

writePendingData();
