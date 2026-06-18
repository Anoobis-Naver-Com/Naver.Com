// netlify/edge-functions/Weather.js
// 공공데이터포털 API 키는 로컬 HTML에서 전달받습니다 (깃허브에 키 없음)
// API 1: 기상청 초단기실황 (현재 날씨)
// API 2: 기상청 단기예보 (3일) + 중기예보 (4~8일)
// API 3: 한국천문연구원 - 일출/일몰/월출/월몰
// API 4: 한국에너지기술연구원 - 실시간 홍반자외선 (위치 기반 자동 선택)
// CALC: 달 월령 · 채워짐(%) - 천문 공식으로 직접 계산

const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
};

// ─── 기상청 격자 변환 (위경도 → XY) ─────────────────────────────────────────
function latLonToGrid(lat, lon) {
    const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0;
    const OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
    const DEGRAD = Math.PI / 180.0;
    const re = RE / GRID;
    const slat1 = SLAT1 * DEGRAD, slat2 = SLAT2 * DEGRAD;
    const olon = OLON * DEGRAD, olat = OLAT * DEGRAD;
    let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
    sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
    let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
    sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
    let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
    ro = (re * sf) / Math.pow(ro, sn);
    let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
    ra = (re * sf) / Math.pow(ra, sn);
    let theta = lon * DEGRAD - olon;
    if (theta > Math.PI) theta -= 2.0 * Math.PI;
    if (theta < -Math.PI) theta += 2.0 * Math.PI;
    theta *= sn;
    return {
        x: Math.floor(ra * Math.sin(theta) + XO + 0.5),
        y: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
    };
}

// ─── 날짜/시간 유틸 ───────────────────────────────────────────────────────────
function getKST() {
    const now = new Date(Date.now() + 9 * 3600 * 1000);
    return {
        year:     now.getUTCFullYear(),
        month:    String(now.getUTCMonth() + 1).padStart(2, '0'),
        day:      String(now.getUTCDate()).padStart(2, '0'),
        hour:     String(now.getUTCHours()).padStart(2, '0'),
        minute:   String(now.getUTCMinutes()).padStart(2, '0'),
        yyyymmdd: `${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,'0')}${String(now.getUTCDate()).padStart(2,'0')}`,
    };
}

function getUltraBaseTime(h, m) {
    if (parseInt(m) < 40) {
        let ph = parseInt(h) - 1;
        if (ph < 0) ph = 23;
        return String(ph).padStart(2, '0') + '00';
    }
    return h + '00';
}

function getShortBaseTime(h, m) {
    const BASES = [2, 5, 8, 11, 14, 17, 20, 23];
    let hh = parseInt(h), mm = parseInt(m);
    for (let i = BASES.length - 1; i >= 0; i--) {
        if (hh > BASES[i] || (hh === BASES[i] && mm >= 45)) {
            return String(BASES[i]).padStart(2, '0') + '00';
        }
    }
    return '2300';
}

function addDays(yyyymmdd, n) {
    const y = parseInt(yyyymmdd.slice(0,4));
    const mo = parseInt(yyyymmdd.slice(4,6)) - 1;
    const d = parseInt(yyyymmdd.slice(6,8));
    const dt = new Date(Date.UTC(y, mo, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return `${dt.getUTCFullYear()}${String(dt.getUTCMonth()+1).padStart(2,'0')}${String(dt.getUTCDate()).padStart(2,'0')}`;
}

const SKY_CODE = { '1':'맑음', '3':'구름많음', '4':'흐림' };
const PTY_CODE = { '0':'없음','1':'비','2':'비/눈','3':'눈','4':'소나기','5':'빗방울','6':'빗방울/눈날림','7':'눈날림' };
const POP_UNIT = '%';

// ─── 메인 핸들러 ─────────────────────────────────────────────────────────────
export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: HEADERS });
    }

    const url = new URL(request.url);
    const p   = url.searchParams;
    const key = p.get('key') ? p.get('key').replace(/[^\x00-\x7F]/g, '') : '';
    const lat = parseFloat(p.get('lat'));
    const lon = parseFloat(p.get('lon'));

    if (!key) return errRes(400, '공공데이터포털 API 키(key)가 없습니다.');
    if (isNaN(lat) || isNaN(lon)) return errRes(400, 'lat(위도)와 lon(경도) 파라미터가 필요합니다.');

    const kst  = getKST();
    const grid = latLonToGrid(lat, lon);
    const encoded = encodeURIComponent(key);

    try {
        const [ultraRes, shortRes, astroRes, uvRes] = await Promise.all([
            fetchUltra(encoded, kst, grid),
            fetchShortAndMid(encoded, kst, grid, lat, lon),
            fetchAstro(encoded, kst, lat, lon),
            fetchUV(encoded, kst, lat, lon),
        ]);

        const moonInfo = calcMoonPhase(kst);

        return new Response(JSON.stringify({
            current:  ultraRes,
            forecast: shortRes,
            astro:    astroRes,
            uv:       uvRes,
            moon:     moonInfo,
            grid:     grid,
            kst:      kst,
        }), { status: 200, headers: HEADERS });

    } catch (e) {
        return errRes(500, '서버 오류: ' + e.message);
    }
}

// ─── 초단기실황 ──────────────────────────────────────────────────────────────
async function fetchUltra(encoded, kst, grid) {
    const baseTime = getUltraBaseTime(kst.hour, kst.minute);
    const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst`
        + `?serviceKey=${encoded}&numOfRows=20&pageNo=1&dataType=JSON`
        + `&base_date=${kst.yyyymmdd}&base_time=${baseTime}`
        + `&nx=${grid.x}&ny=${grid.y}`;

    const res  = await fetch(url);
    const data = await res.json();
    const items = data?.response?.body?.items?.item || [];

    const map = {};
    items.forEach(i => { map[i.category] = i.obsrValue; });

    return {
        baseDate: kst.yyyymmdd,
        baseTime: baseTime,
        temp:     map['T1H'] !== undefined ? map['T1H'] + '°C' : null,
        humidity: map['REH'] !== undefined ? map['REH'] + '%' : null,
        pty:      PTY_CODE[map['PTY']] || '없음',
        ptyCode:  map['PTY'] || '0',
        windDir:  map['VEC'] !== undefined ? map['VEC'] + '°' : null,
        windSpd:  map['WSD'] !== undefined ? map['WSD'] + 'm/s' : null,
        rain1h:   map['RN1'] !== undefined ? map['RN1'] + 'mm' : null,
    };
}

// ─── 단기예보 + 중기예보 합산 (8일치) ────────────────────────────────────────
async function fetchShortAndMid(encoded, kst, grid, lat, lon) {
    const shortBaseTime = getShortBaseTime(kst.hour, kst.minute);
    let shortBaseDate = kst.yyyymmdd;
    if (shortBaseTime === '2300' && parseInt(kst.hour) < 3) {
        shortBaseDate = addDays(kst.yyyymmdd, -1);
    }

    const shortUrl = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst`
        + `?serviceKey=${encoded}&numOfRows=1000&pageNo=1&dataType=JSON`
        + `&base_date=${shortBaseDate}&base_time=${shortBaseTime}`
        + `&nx=${grid.x}&ny=${grid.y}`;

    const midCode    = getMidLandCode(lat, lon);
    const midTmpCode = getMidTaCode(lat, lon);
    const midTime    = parseInt(kst.hour) >= 18 ? '1800' : '0600';
    let midDate = kst.yyyymmdd;
    if (midTime === '0600' && parseInt(kst.hour) < 6) {
        midDate = addDays(kst.yyyymmdd, -1);
    }
    const midTm = midDate + (parseInt(kst.hour) >= 18 ? '1800' : '0600');

    const midLandUrl = `https://apis.data.go.kr/1360000/MidFcstInfoService/getMidLandFcst`
        + `?serviceKey=${encoded}&numOfRows=10&pageNo=1&dataType=JSON&regId=${midCode}&tmFc=${midTm}`;

    const midTaUrl = `https://apis.data.go.kr/1360000/MidFcstInfoService/getMidTa`
        + `?serviceKey=${encoded}&numOfRows=10&pageNo=1&dataType=JSON&regId=${midTmpCode}&tmFc=${midTm}`;

    const [shortRes, midLandRes, midTaRes] = await Promise.all([
        fetch(shortUrl).then(r => r.json()),
        fetch(midLandUrl).then(r => r.json()),
        fetch(midTaUrl).then(r => r.json()),
    ]);

    const shortItems = shortRes?.response?.body?.items?.item || [];
    const dayMap = {};

    shortItems.forEach(item => {
        const dt = item.fcstDate;
        if (!dayMap[dt]) dayMap[dt] = { sky: null, pty: '0', pop: null, tmx: null, tmn: null };
        if (item.category === 'SKY' && item.fcstTime === '1500') dayMap[dt].sky = item.fcstValue;
        if (item.category === 'PTY' && item.fcstTime === '1500') dayMap[dt].pty = item.fcstValue;
        if (item.category === 'POP' && item.fcstTime === '1500') dayMap[dt].pop = item.fcstValue;
        if (item.category === 'TMX') dayMap[dt].tmx = item.fcstValue;
        if (item.category === 'TMN') dayMap[dt].tmn = item.fcstValue;
    });

    const midLandItem = midLandRes?.response?.body?.items?.item?.[0] || {};
    const midTaItem   = midTaRes?.response?.body?.items?.item?.[0] || {};

    const days = [];
    for (let i = 0; i <= 7; i++) {
        const dt    = addDays(kst.yyyymmdd, i);
        const label = getDayLabel(dt, kst.yyyymmdd);

        if (i <= 2 && dayMap[dt]) {
            const d = dayMap[dt];
            days.push({
                date: dt, label,
                sky:     SKY_CODE[d.sky] || '—',
                pty:     PTY_CODE[d.pty] || '없음',
                ptyCode: d.pty || '0',
                pop:     d.pop !== null ? d.pop + POP_UNIT : null,
                tmx:     d.tmx !== null ? d.tmx + '°C' : null,
                tmn:     d.tmn !== null ? d.tmn + '°C' : null,
                source:  'short',
            });
        } else if (i >= 3 && i <= 7) {
            const n     = i + 1;
            const skyAm = midLandItem[`wf${n}Am`] || midLandItem[`wf${n}`] || '—';
            const skyPm = midLandItem[`wf${n}Pm`] || '';
            const rnSt  = midLandItem[`rnSt${n}Am`] ?? midLandItem[`rnSt${n}`] ?? null;
            const taMax = midTaItem[`taMax${n}`] ?? null;
            const taMin = midTaItem[`taMin${n}`] ?? null;
            days.push({
                date: dt, label,
                sky:     skyAm + (skyPm && skyPm !== skyAm ? ` / ${skyPm}` : ''),
                pty:     null,
                ptyCode: '0',
                pop:     rnSt !== null ? rnSt + POP_UNIT : null,
                tmx:     taMax !== null ? taMax + '°C' : null,
                tmn:     taMin !== null ? taMin + '°C' : null,
                source:  'mid',
            });
        }
    }
    return days;
}

// ─── 한국천문연구원 일출/일몰/월출/월몰 ─────────────────────────────────────
async function fetchAstro(encoded, kst, lat, lon) {
    const locdate = `${kst.year}${kst.month}${kst.day}`;
    const url = `https://apis.data.go.kr/B090041/openapi/service/RiseSetInfoService/getLCRiseSetInfo`
        + `?serviceKey=${encoded}&locdate=${locdate}&longitude=${lon.toFixed(6)}&latitude=${lat.toFixed(6)}&dnYn=Y`;

    const res  = await fetch(url);
    const text = await res.text();
    const get  = (tag) => {
        const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        return m ? m[1].trim() : null;
    };

    return {
        date:      locdate,
        sunrise:   formatTime(get('sunrise')),
        sunset:    formatTime(get('sunset')),
        moonrise:  formatTime(get('moonrise')),
        moonset:   formatTime(get('moonset')),
        solarNoon: formatTime(get('solarnoon')),
        civilDawn: formatTime(get('civiltwilight_start')),
        civilDusk: formatTime(get('civiltwilight_end')),
    };
}

// ─── 한국에너지기술연구원 실시간 홍반자외선 ────────────────────────────────────
// 천리안 위성 기반 격자 데이터 → 위경도 직접 조회 (관측소 불필요)
async function fetchUV(encoded, kst, lat, lon) {
    // 날짜 파라미터: YYYYMMDD
    const date = kst.yyyymmdd;
    // 시간 파라미터: 현재 시 (HH00 형식, 1시간 단위)
    const hour = kst.hour + '00';

    const url = `https://apis.data.go.kr/B552895/rltmUlvryInfo/getRltmUlvryInfo`
        + `?serviceKey=${encoded}&dataType=JSON`
        + `&date=${date}&time=${hour}`
        + `&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;

    try {
        const res  = await fetch(url);
        const data = await res.json();
        const items = data?.response?.body?.items?.item || [];
        const item  = Array.isArray(items) ? items[0] : items;

        if (!item) return { index: null, level: null, levelName: null };

        // uv 지수값 (필드명: ulvryVal 또는 uvi)
        const raw = item.ulvryVal ?? item.uvi ?? item.uvIndex ?? null;
        const uvi = raw !== null ? parseFloat(raw) : null;

        return {
            index:     uvi !== null ? Math.round(uvi * 10) / 10 : null,
            level:     uvi !== null ? uvLevel(uvi) : null,
            levelName: uvi !== null ? uvLevelName(uvi) : null,
        };
    } catch {
        return { index: null, level: null, levelName: null };
    }
}

// 자외선 5단계 (WHO/환경부 기준)
// 1: 낮음(0~2), 2: 보통(3~5), 3: 높음(6~7), 4: 매우높음(8~10), 5: 위험(11+)
function uvLevel(uvi) {
    if (uvi <= 2)  return 1;
    if (uvi <= 5)  return 2;
    if (uvi <= 7)  return 3;
    if (uvi <= 10) return 4;
    return 5;
}
function uvLevelName(uvi) {
    return ['낮음','보통','높음','매우높음','위험'][uvLevel(uvi) - 1];
}

// ─── 달 월령 · 채워짐(%) 계산 ────────────────────────────────────────────────
// Jean Meeus "Astronomical Algorithms" 기반
// 한국천문연구원이 사용하는 것과 동일한 Julian Day + 시노딕 주기 방식
function calcMoonPhase(kst) {
    const y  = parseInt(kst.year);
    const mo = parseInt(kst.month);
    const d  = parseInt(kst.day);
    const h  = parseInt(kst.hour);

    // Julian Day Number 계산
    const A  = Math.floor((14 - mo) / 12);
    const Y  = y + 4800 - A;
    const M  = mo + 12 * A - 3;
    const JDN = d + Math.floor((153 * M + 2) / 5) + 365 * Y
              + Math.floor(Y / 4) - Math.floor(Y / 100) + Math.floor(Y / 400) - 32045;
    const JD = JDN + (h - 12) / 24.0;  // 정오 기준 보정

    // 기준 신월(New Moon): 2000년 1월 6일 18:14 UTC → JD 2451550.1
    const KNOWN_NEW_MOON_JD = 2451550.1;
    const SYNODIC = 29.53058867;        // 삭망 주기(일)

    const daysSinceNew = (JD - KNOWN_NEW_MOON_JD) % SYNODIC;
    const age = daysSinceNew < 0 ? daysSinceNew + SYNODIC : daysSinceNew;  // 0~29.53

    // 채워짐(illumination) %: 코사인 근사
    const illumination = Math.round((1 - Math.cos(2 * Math.PI * age / SYNODIC)) / 2 * 100);

    // 달 이름 (8분류)
    const phaseNames = ['삭(신월)','초승달','상현달','차오르는 볼록달','망(보름달)','이지러지는 볼록달','하현달','그믐달'];
    const phaseIdx   = Math.floor((age / SYNODIC) * 8) % 8;

    // 이모지
    const phaseEmoji = ['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'];

    return {
        age:          Math.round(age * 10) / 10,   // 월령 (소수 1자리)
        illumination: illumination,                  // 채워짐 %
        phaseName:    phaseNames[phaseIdx],
        phaseEmoji:   phaseEmoji[phaseIdx],
    };
}

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────
function formatTime(t) {
    if (!t || t.length < 4) return null;
    return t.slice(0, 2) + ':' + t.slice(2, 4);
}

function getDayLabel(dt, todayDt) {
    const DAYS = ['일','월','화','수','목','금','토'];
    const y = parseInt(dt.slice(0,4)), mo = parseInt(dt.slice(4,6))-1, d = parseInt(dt.slice(6,8));
    const dow  = DAYS[new Date(Date.UTC(y,mo,d)).getUTCDay()];
    const diff = Math.round((new Date(Date.UTC(y,mo,d)) - new Date(Date.UTC(parseInt(todayDt.slice(0,4)),parseInt(todayDt.slice(4,6))-1,parseInt(todayDt.slice(6,8))))) / 86400000);
    if (diff === 0) return `오늘 (${dow})`;
    if (diff === 1) return `내일 (${dow})`;
    if (diff === 2) return `모레 (${dow})`;
    return `${dt.slice(4,6)}/${dt.slice(6,8)} (${dow})`;
}

function getMidLandCode(lat, lon) {
    if (lat >= 37.7) return '11B10101';
    if (lat >= 37.2 && lon < 127.5) return '11B20101';
    if (lat >= 36.5 && lat < 37.2 && lon < 127.8) return '11C20401';
    if (lat >= 36.5 && lat < 37.2 && lon >= 127.8) return '11C10301';
    if (lat >= 35.5 && lat < 36.5 && lon < 127.5) return '11F20501';
    if (lat >= 34.5 && lat < 35.5 && lon < 126.8) return '11F10201';
    if (lat >= 34.5 && lat < 35.5 && lon >= 126.8) return '11F20401';
    if (lat >= 35.5 && lat < 36.5 && lon >= 128.5) return '11H10701';
    if (lat >= 34.5 && lat < 35.5 && lon >= 128.5) return '11H20101';
    if (lat >= 35.0 && lat < 35.5 && lon >= 127.5 && lon < 128.5) return '11H20301';
    if (lat >= 33.0 && lat < 34.0) return '11G00201';
    if (lon >= 129.0 && lat >= 37.0) return '11E00101';
    if (lon < 129.0 && lat >= 37.0) return '11D10301';
    return '11B10101';
}

function getMidTaCode(lat, lon) {
    if (lat >= 37.5 && lon >= 126.5 && lon < 127.5) return '11B10101';
    if (lat >= 37.5 && lon >= 127.5) return '11B20601';
    if (lat >= 37.2 && lat < 37.5) return '11B20401';
    if (lat >= 36.5 && lat < 37.2 && lon < 127.5) return '11C20101';
    if (lat >= 36.5 && lat < 37.2 && lon >= 127.5) return '11C10201';
    if (lat >= 35.5 && lat < 36.5 && lon < 127.5) return '11F20401';
    if (lat >= 34.8 && lat < 35.5 && lon >= 128.5) return '11H20101';
    if (lat >= 35.0 && lat < 35.3 && lon >= 129.0) return '11H20201';
    if (lat >= 35.5 && lat < 36.5 && lon >= 128.5) return '11H10501';
    if (lat >= 34.5 && lat < 35.0 && lon < 127.0) return '11F10501';
    if (lat >= 33.0 && lat < 34.0) return '11G00101';
    if (lon >= 129.0 && lat >= 37.5) return '11E00101';
    return '11B10101';
}

function errRes(status, msg) {
    return new Response(JSON.stringify({ error: msg }), { status, headers: HEADERS });
}

export const config = { path: '/api/weather' };
