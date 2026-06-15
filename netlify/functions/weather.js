// netlify/functions/weather.js
// 공공데이터포털 API 키는 로컬 HTML에서 전달받습니다 (깃허브에 키 없음)
// API 1: 기상청 초단기실황 (현재 날씨)
// API 2: 기상청 단기예보 (3일) + 중기예보 (4~8일)
// API 3: 한국천문연구원 - 일출/일몰/월출/월몰

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
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
    year:   now.getUTCFullYear(),
    month:  String(now.getUTCMonth() + 1).padStart(2, "0"),
    day:    String(now.getUTCDate()).padStart(2, "0"),
    hour:   String(now.getUTCHours()).padStart(2, "0"),
    minute: String(now.getUTCMinutes()).padStart(2, "0"),
    yyyymmdd: `${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,"0")}${String(now.getUTCDate()).padStart(2,"0")}`,
  };
}

// 초단기실황 기준시각: 매시 30분 이전이면 이전 시각 사용
function getUltraBaseTime(h, m) {
  if (parseInt(m) < 40) {
    let ph = parseInt(h) - 1;
    if (ph < 0) ph = 23;
    return String(ph).padStart(2, "0") + "00";
  }
  return h + "00";
}

// 단기예보 기준시각: 02/05/08/11/14/17/20/23시 발표 (45분 이후 유효)
function getShortBaseTime(h, m) {
  const BASES = [2, 5, 8, 11, 14, 17, 20, 23];
  let hh = parseInt(h), mm = parseInt(m);
  // 현재 시각이 기준시각 + 45분 이전이면 이전 기준 사용
  for (let i = BASES.length - 1; i >= 0; i--) {
    if (hh > BASES[i] || (hh === BASES[i] && mm >= 45)) {
      return String(BASES[i]).padStart(2, "0") + "00";
    }
  }
  return "2300"; // 자정 직후면 전날 23시
}

function addDays(yyyymmdd, n) {
  const y = parseInt(yyyymmdd.slice(0,4));
  const mo = parseInt(yyyymmdd.slice(4,6)) - 1;
  const d = parseInt(yyyymmdd.slice(6,8));
  const dt = new Date(Date.UTC(y, mo, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth()+1).padStart(2,"0")}${String(dt.getUTCDate()).padStart(2,"0")}`;
}

// ─── 기상청 하늘상태/강수형태 코드 → 텍스트 ─────────────────────────────────
const SKY_CODE  = { "1":"맑음", "3":"구름많음", "4":"흐림" };
const PTY_CODE  = { "0":"없음","1":"비","2":"비/눈","3":"눈","4":"소나기","5":"빗방울","6":"빗방울/눈날림","7":"눈날림" };
const POP_UNIT  = "%";

// ─── 메인 핸들러 ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };

  const p = event.queryStringParameters || {};
  const key = p.key ? p.key.replace(/[^\x00-\x7F]/g, "") : "";
  const lat = parseFloat(p.lat);
  const lon = parseFloat(p.lon);

  if (!key) return err(400, "공공데이터포털 API 키(key)가 없습니다.");
  if (isNaN(lat) || isNaN(lon)) return err(400, "lat(위도)와 lon(경도) 파라미터가 필요합니다.");

  const kst = getKST();
  const grid = latLonToGrid(lat, lon);
  const encoded = encodeURIComponent(key);

  try {
    const [ultraRes, shortRes, astroRes] = await Promise.all([
      // 1) 초단기실황
      fetchUltra(encoded, kst, grid),
      // 2) 단기예보 (오늘~모레) + 중기육상예보 (4~8일)
      fetchShortAndMid(encoded, kst, grid, lat, lon),
      // 3) 한국천문연구원 일출/일몰/월출/월몰
      fetchAstro(encoded, kst, lat, lon),
    ]);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        current:  ultraRes,
        forecast: shortRes,
        astro:    astroRes,
        grid:     grid,
        kst:      kst,
      }),
    };
  } catch (e) {
    return err(500, "서버 오류: " + e.message);
  }
};

// ─── 초단기실황 ──────────────────────────────────────────────────────────────
async function fetchUltra(encoded, kst, grid) {
  const baseTime = getUltraBaseTime(kst.hour, kst.minute);
  const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst`
    + `?serviceKey=${encoded}&numOfRows=20&pageNo=1&dataType=JSON`
    + `&base_date=${kst.yyyymmdd}&base_time=${baseTime}`
    + `&nx=${grid.x}&ny=${grid.y}`;

  const res = await fetch(url);
  const data = await res.json();
  const items = data?.response?.body?.items?.item || [];

  const map = {};
  items.forEach(i => { map[i.category] = i.obsrValue; });

  return {
    baseDate: kst.yyyymmdd,
    baseTime: baseTime,
    temp:     map["T1H"] !== undefined ? map["T1H"] + "°C" : null,
    humidity: map["REH"] !== undefined ? map["REH"] + "%" : null,
    pty:      PTY_CODE[map["PTY"]] || "없음",
    ptyCode:  map["PTY"] || "0",
    windDir:  map["VEC"] !== undefined ? map["VEC"] + "°" : null,
    windSpd:  map["WSD"] !== undefined ? map["WSD"] + "m/s" : null,
    rain1h:   map["RN1"] !== undefined ? map["RN1"] + "mm" : null,
  };
}

// ─── 단기예보 + 중기예보 합산 (8일치) ────────────────────────────────────────
async function fetchShortAndMid(encoded, kst, grid, lat, lon) {
  // 단기예보: 오늘~3일후
  const shortBaseTime = getShortBaseTime(kst.hour, kst.minute);
  // 단기예보가 전날 23시 기준이면 날짜도 하루 전으로
  let shortBaseDate = kst.yyyymmdd;
  if (shortBaseTime === "2300" && parseInt(kst.hour) < 3) {
    shortBaseDate = addDays(kst.yyyymmdd, -1);
  }

  const shortUrl = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst`
    + `?serviceKey=${encoded}&numOfRows=1000&pageNo=1&dataType=JSON`
    + `&base_date=${shortBaseDate}&base_time=${shortBaseTime}`
    + `&nx=${grid.x}&ny=${grid.y}`;

  // 중기육상예보: 지점코드 필요 (위경도로 대략 매핑)
  const midCode = getMidLandCode(lat, lon);
  const midTmpCode = getMidTaCode(lat, lon);
  // 중기예보 발표시각: 06시 or 18시
  const midTime = parseInt(kst.hour) >= 18 ? "1800" : "0600";
  let midDate = kst.yyyymmdd;
  if (midTime === "0600" && parseInt(kst.hour) < 6) {
    midDate = addDays(kst.yyyymmdd, -1);
    // 전날 18시 기준으로
  }
  const midTm = midDate + (parseInt(kst.hour) >= 18 ? "1800" : "0600");

  const midLandUrl = `https://apis.data.go.kr/1360000/MidFcstInfoService/getMidLandFcst`
    + `?serviceKey=${encoded}&numOfRows=10&pageNo=1&dataType=JSON&regId=${midCode}&tmFc=${midTm}`;

  const midTaUrl = `https://apis.data.go.kr/1360000/MidFcstInfoService/getMidTa`
    + `?serviceKey=${encoded}&numOfRows=10&pageNo=1&dataType=JSON&regId=${midTmpCode}&tmFc=${midTm}`;

  const [shortRes, midLandRes, midTaRes] = await Promise.all([
    fetch(shortUrl).then(r => r.json()),
    fetch(midLandUrl).then(r => r.json()),
    fetch(midTaUrl).then(r => r.json()),
  ]);

  // 단기예보 파싱: 날짜별 TMX(최고)/TMN(최저)/SKY/PTY/POP
  const shortItems = shortRes?.response?.body?.items?.item || [];
  const dayMap = {}; // { yyyymmdd: { sky, pty, pop, tmx, tmn } }

  shortItems.forEach(item => {
    const dt = item.fcstDate;
    if (!dayMap[dt]) dayMap[dt] = { sky: null, pty: "0", pop: null, tmx: null, tmn: null };
    if (item.category === "SKY" && item.fcstTime === "1500") dayMap[dt].sky = item.fcstValue;
    if (item.category === "PTY" && item.fcstTime === "1500") dayMap[dt].pty = item.fcstValue;
    if (item.category === "POP" && item.fcstTime === "1500") dayMap[dt].pop = item.fcstValue;
    if (item.category === "TMX") dayMap[dt].tmx = item.fcstValue;
    if (item.category === "TMN") dayMap[dt].tmn = item.fcstValue;
  });

  // 중기예보 파싱 (4~8일)
  const midLandItem = midLandRes?.response?.body?.items?.item?.[0] || {};
  const midTaItem   = midTaRes?.response?.body?.items?.item?.[0] || {};

  // 8일치 배열 생성
  const days = [];
  for (let i = 0; i <= 7; i++) {
    const dt = addDays(kst.yyyymmdd, i);
    const label = getDayLabel(dt, kst.yyyymmdd);

    if (i <= 2 && dayMap[dt]) {
      // 단기예보 데이터
      const d = dayMap[dt];
      days.push({
        date:    dt,
        label:   label,
        sky:     SKY_CODE[d.sky] || "—",
        pty:     PTY_CODE[d.pty] || "없음",
        ptyCode: d.pty || "0",
        pop:     d.pop !== null ? d.pop + POP_UNIT : null,
        tmx:     d.tmx !== null ? d.tmx + "°C" : null,
        tmn:     d.tmn !== null ? d.tmn + "°C" : null,
        source:  "short",
      });
    } else if (i >= 3 && i <= 7) {
      // 중기예보 (3일차부터 API에서는 +3~+10일 키 사용)
      const n = i + 1; // API 키: rnSt3Am, taMax3 등 (D+3 = index 3)
      const skyAm = midLandItem[`wf${n}Am`] || midLandItem[`wf${n}`] || "—";
      const skyPm = midLandItem[`wf${n}Pm`] || "";
      const rnSt  = midLandItem[`rnSt${n}Am`] ?? midLandItem[`rnSt${n}`] ?? null;
      const taMax = midTaItem[`taMax${n}`] ?? null;
      const taMin = midTaItem[`taMin${n}`] ?? null;

      days.push({
        date:    dt,
        label:   label,
        sky:     skyAm + (skyPm && skyPm !== skyAm ? ` / ${skyPm}` : ""),
        pty:     null,
        ptyCode: "0",
        pop:     rnSt !== null ? rnSt + POP_UNIT : null,
        tmx:     taMax !== null ? taMax + "°C" : null,
        tmn:     taMin !== null ? taMin + "°C" : null,
        source:  "mid",
      });
    }
  }

  return days;
}

// ─── 한국천문연구원 일출/일몰/월출/월몰 ─────────────────────────────────────
async function fetchAstro(encoded, kst, lat, lon) {
  const date = `${kst.year}${kst.month}${kst.day}`;
  const locdate = date;

  // 위경도 → 주요 도시 코드 (한국천문연구원 API는 지역코드 또는 위경도 지원)
  // /B090041/openapi/service/RiseSetInfoService/getLCRiseSetInfo : 위경도 직접 사용 가능
  const baseUrl = `https://apis.data.go.kr/B090041/openapi/service/RiseSetInfoService/getLCRiseSetInfo`;
  const url = `${baseUrl}?serviceKey=${encoded}&locdate=${locdate}&longitude=${lon.toFixed(6)}&latitude=${lat.toFixed(6)}&dnYn=Y`;

  const res = await fetch(url);
  const text = await res.text();

  // XML 파싱 (간단하게 정규식으로)
  const get = (tag) => {
    const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1].trim() : null;
  };

  return {
    date:      locdate,
    sunrise:   formatTime(get("sunrise")),
    sunset:    formatTime(get("sunset")),
    moonrise:  formatTime(get("moonrise")),
    moonset:   formatTime(get("moonset")),
    solarNoon: formatTime(get("solarnoon")),
    civilDawn: formatTime(get("civiltwilight_start")),  // 시민박명 시작
    civilDusk: formatTime(get("civiltwilight_end")),    // 시민박명 끝
  };
}

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────
function formatTime(t) {
  if (!t || t.length < 4) return null;
  return t.slice(0, 2) + ":" + t.slice(2, 4);
}

function getDayLabel(dt, todayDt) {
  const DAYS = ["일","월","화","수","목","금","토"];
  const y = parseInt(dt.slice(0,4)), mo = parseInt(dt.slice(4,6))-1, d = parseInt(dt.slice(6,8));
  const dow = DAYS[new Date(Date.UTC(y,mo,d)).getUTCDay()];
  const diff = Math.round((new Date(Date.UTC(y,mo,d)) - new Date(Date.UTC(parseInt(todayDt.slice(0,4)),parseInt(todayDt.slice(4,6))-1,parseInt(todayDt.slice(6,8))))) / 86400000);
  if (diff === 0) return `오늘 (${dow})`;
  if (diff === 1) return `내일 (${dow})`;
  if (diff === 2) return `모레 (${dow})`;
  return `${dt.slice(4,6)}/${dt.slice(6,8)} (${dow})`;
}

// 기상청 중기육상예보 지점코드 (위경도 기반 단순 매핑)
function getMidLandCode(lat, lon) {
  if (lat >= 37.7) return "11B10101"; // 서울/경기북부
  if (lat >= 37.2 && lon < 127.5) return "11B20101"; // 경기남부
  if (lat >= 36.5 && lat < 37.2 && lon < 127.8) return "11C20401"; // 충남
  if (lat >= 36.5 && lat < 37.2 && lon >= 127.8) return "11C10301"; // 충북
  if (lat >= 35.5 && lat < 36.5 && lon < 127.5) return "11F20501"; // 전북
  if (lat >= 34.5 && lat < 35.5 && lon < 126.8) return "11F10201"; // 전남서부
  if (lat >= 34.5 && lat < 35.5 && lon >= 126.8) return "11F20401"; // 전남동부
  if (lat >= 35.5 && lat < 36.5 && lon >= 128.5) return "11H10701"; // 경북
  if (lat >= 34.5 && lat < 35.5 && lon >= 128.5) return "11H20101"; // 경남
  if (lat >= 35.0 && lat < 35.5 && lon >= 127.5 && lon < 128.5) return "11H20301"; // 부산/울산/경남
  if (lat >= 33.0 && lat < 34.0) return "11G00201"; // 제주
  if (lon >= 129.0 && lat >= 37.0) return "11E00101"; // 강원영동
  if (lon < 129.0 && lat >= 37.0) return "11D10301"; // 강원영서
  return "11B10101"; // 기본값
}

function getMidTaCode(lat, lon) {
  if (lat >= 37.5 && lon >= 126.5 && lon < 127.5) return "11B10101"; // 서울
  if (lat >= 37.5 && lon >= 127.5) return "11B20601"; // 경기동부
  if (lat >= 37.2 && lat < 37.5) return "11B20401"; // 경기남부
  if (lat >= 36.5 && lat < 37.2 && lon < 127.5) return "11C20101"; // 대전
  if (lat >= 36.5 && lat < 37.2 && lon >= 127.5) return "11C10201"; // 청주
  if (lat >= 35.5 && lat < 36.5 && lon < 127.5) return "11F20401"; // 전주
  if (lat >= 34.8 && lat < 35.5 && lon >= 128.5) return "11H20101"; // 창원
  if (lat >= 35.0 && lat < 35.3 && lon >= 129.0) return "11H20201"; // 부산
  if (lat >= 35.5 && lat < 36.5 && lon >= 128.5) return "11H10501"; // 대구
  if (lat >= 34.5 && lat < 35.0 && lon < 127.0) return "11F10501"; // 목포
  if (lat >= 33.0 && lat < 34.0) return "11G00101"; // 제주
  if (lon >= 129.0 && lat >= 37.5) return "11E00101"; // 강릉
  return "11B10101";
}

function err(status, msg) {
  return { statusCode: status, headers: HEADERS, body: JSON.stringify({ error: msg }) };
}
