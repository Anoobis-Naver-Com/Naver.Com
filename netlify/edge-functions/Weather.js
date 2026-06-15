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

    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    const lat = url.searchParams.get('lat');
    const lon = url.searchParams.get('lon');

    if (!key || !lat || !lon) {
        return new Response(JSON.stringify({ error: 'key, lat, lon 파라미터 필요' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    const target = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?serviceKey=${encodeURIComponent(key)}&lat=${lat}&lon=${lon}`;

    try {
        const res = await fetch(target, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error('http ' + res.status);
        const data = await res.json();
        return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: '날씨 API 호출 실패' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}

export const config = { path: '/api/weather' };
