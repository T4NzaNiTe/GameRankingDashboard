import fs from 'fs';

// 1. 25일 08시 장부(비교 기준)와 문제가 있는 14시 장부 불러오기
const prevData = JSON.parse(fs.readFileSync('./history/2026-06-25_08.json', 'utf8'));
const currentData = JSON.parse(fs.readFileSync('./history/2026-06-26_14.json', 'utf8'));

// 2. 25일 순위를 기준으로 '순위 변동 수치' 다시 계산하기
function enrichDataWithRankChange(currentList, previousData) {
    const previousRanks = {};
    previousData.forEach((g, index) => {
        const id = g.appId || g.title || g.name;
        previousRanks[id] = index + 1;
    });

    currentList.forEach((game, index) => {
        const id = game.appId || game.title || game.name;
        const currentRank = index + 1;
        game.rankChange = previousRanks[id] ? previousRanks[id] - currentRank : 'new';
    });
}

enrichDataWithRankChange(currentData.steamGlobal, prevData.steamGlobal);
enrichDataWithRankChange(currentData.playKr, prevData.playKr);

// 3. 다시 예쁘게 계산된 14시 데이터를 덮어쓰기
fs.writeFileSync('./history/2026-06-26_14.json', JSON.stringify(currentData, null, 2), 'utf8');
fs.writeFileSync('./data.json', JSON.stringify(currentData, null, 2), 'utf8');

console.log("✅ 14시 순위 변동 수치가 25일 기준으로 완벽하게 복구되었습니다!");
