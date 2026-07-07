import { getStore } from '@netlify/blobs';

const LATEST_KEY = 'weather-latest';
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': '*',
            }
        });
    }

    try {
        const store = getStore('location-cache');
        const saved = await store.get(LATEST_KEY, { type: 'json' });

        if (!saved) {
            return new Response(JSON.stringify({ data: null }), { status: 200, headers: HEADERS });
        }

        return new Response(JSON.stringify({
            data: saved.data,
            savedAt: saved.savedAt,
        }), { status: 200, headers: HEADERS });

    } catch (e) {
        return new Response(JSON.stringify({ data: null, error: '저장된 값 조회 실패', detail: e.message }), { status: 200, headers: HEADERS });
    }
}

export const config = { path: '/api/weather-latest' };
