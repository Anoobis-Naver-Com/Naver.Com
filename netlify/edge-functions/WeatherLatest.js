import { getStore } from '@netlify/blobs';

// 데스크탑 전용 조회 엔드포인트.
// 외부(기상청) API를 호출하지 않고, 모바일이 마지막으로 저장해 둔 값만 반환한다.
// - 저장된 값이 있으면: { data: {...}, updatedAt: "..." }
// - 저장된 값이 없으면: { data: null }
const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
};

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: HEADERS });
    }

    try {
        const store = getStore({ name: 'location-cache' });
        const cached = await store.get('weather-latest', { type: 'json' });

        if (!cached) {
            return new Response(JSON.stringify({ data: null }), { status: 200, headers: HEADERS });
        }

        return new Response(JSON.stringify({
            data: cached.data,
            updatedAt: cached.updatedAt || null,
        }), { status: 200, headers: HEADERS });

    } catch (e) {
        return new Response(JSON.stringify({ data: null, error: '조회 실패', detail: e.message }), { status: 200, headers: HEADERS });
    }
}

export const config = { path: '/api/weather-latest' };
