// netlify/functions/weather-latest.js
// 외부(기상청/천문연구원) API는 호출하지 않고, weather.js가 저장해 둔 최신 값만 반환한다.
// 데스크탑에서 GPS 없이 폴링(주기적 요청)할 때 사용하는 엔드포인트.
// TTL(만료 시간)은 적용하지 않는다 — 저장된 값은 언제든 그대로 반환한다.

const { getStore } = require('@netlify/blobs');

const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
};

const STORE_NAME = 'weather-cache';
const BLOB_KEY = 'latest';

exports.handler = async function (event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }

    try {
        const store = getStore(STORE_NAME);
        const data = await store.get(BLOB_KEY, { type: 'json' });

        if (!data) {
            return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ data: null }) };
        }

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify(data) };
    } catch (e) {
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ data: null, error: e.message }) };
    }
};
