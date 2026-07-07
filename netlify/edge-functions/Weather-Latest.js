import { getStore } from "@netlify/blobs";

const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
};

const LATEST_KEY = "latest";

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: HEADERS });
    }

    try {
        const store = getStore("weather-cache");
        const saved = await store.get(LATEST_KEY, { type: "json" });

        if (!saved) {
            return new Response(JSON.stringify({ data: null }), { status: 200, headers: HEADERS });
        }

        return new Response(JSON.stringify({ data: saved }), { status: 200, headers: HEADERS });
    } catch (e) {
        return new Response(JSON.stringify({ data: null, error: '서버 내부 오류', detail: e.message }), { status: 500, headers: HEADERS });
    }
}

export const config = { path: '/api/weather-latest' };
