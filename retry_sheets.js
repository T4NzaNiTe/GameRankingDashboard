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
    const retries = 5; 
    
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
                            await delay(2000); 
                        }
                    } catch(e) {
                        console.log(`[안내] 기존 탭 삭제 중 예외 발생 (무시하고 진행): ${e.message}`);
                    }

                    console.log(`[복구 중] '${nowStr}' 이름의 새 시트 탭 생성 중...`);
                    // 🚀 메인 크롤러와 100% 동일한 그리드 사이즈로 생성
                    sheet = await doc.addSheet({ title: nowStr, gridProperties: { rowCount: 105, columnCount: 10 } });

                    await delay(2000);

                    // 🚀 메인 크롤러와 100% 동일한 셀 단위 정밀 로드
                    await sheet.loadCells('A1:H102');

                    const headers = [
                        "순위", "스팀(한국) 게임명", "스팀(한국) 개발사", "",
                        "순위", "구글(한국) 게임명", "구글(한국) 개발사"
                    ];

                    // 🚀 1행 A1 셀: 예쁜 대시보드 버튼 서식 완벽 복구
                    const a1 = sheet.getCell(0, 0);
                    a1.formula = `=HYPERLINK("${DASHBOARD_URL}", "🖥️ 웹 대시보드 열기")`;
                    a1.textFormat = { bold: true, fontSize: 12 };
                    a1.backgroundColor = { red: 0.8, green: 0.9, blue: 1.0 };

                    // 🚀 2행: 헤더 서식 및 연회색 배경 완벽 복구
                    for(let c = 0; c < headers.length; c++) {
                        const cell = sheet.getCell(1, c);
                        cell.value = headers[c];
                        cell.textFormat = { bold: true };
                        cell.backgroundColor = { red: 0.9, green: 0.9, blue: 0.9 };
                    }

                    const steamData = item.steamGlobal || [];
                    // 메인 크롤러 저장 방식(playKr)과 기존 펜딩 방식(googlePlay) 모두 완벽 호환되도록 방어
                    const googleData = item.playKr || item.googlePlay || [];

                    // 🚀 3행~102행: 메인 크롤러와 100% 동일한 열 배치
                    for (let i = 0; i < 100; i++) {
                        const rowIdx = i + 2;
                        if (i < steamData.length) {
                            sheet.getCell(rowIdx, 0).value = i + 1;
                            sheet.getCell(rowIdx, 1).value = steamData[i].name || '';
                            sheet.getCell(rowIdx, 2).value = steamData[i].developer || '';
                        }
                        if (i < googleData.length) {
                            sheet.getCell(rowIdx, 4).value = i + 1;
                            // 구글 데이터의 게임명 필드(title 또는 name) 모두 완벽 커버
                            sheet.getCell(rowIdx, 5).value = googleData[i].title || googleData[i].name || '';
                            sheet.getCell(rowIdx, 6).value = googleData[i].developer || '';
                        }
                    }

                    console.log(`[복구 중] '${nowStr}' 탭에 셀 데이터 저장 중...`);
                    await sheet.saveUpdatedCells();
                    console.log(`[성공] '${nowStr}' 탭 복구 및 서식 적용 완료.`);
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
                return; 
            } else {
                console.log("No items were successfully written in this attempt.");
                throw new Error("성공한 시트 복구 건수가 0건입니다.");
            }

        } catch (e) {
            console.error(`[Google Sheets] 처리 실패 (시도 ${attempt}/${retries}):`, e.message);
            if (attempt < retries) {
                console.log("5초 대기 후 재시도합니다...");
                await delay(5000); 
            }
        }
    }

    console.error("❌ 구글 시트 복구 최종 실패 (5회 시도 초과).");
    process.exit(1);
}

writePendingData();
