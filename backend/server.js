require('dotenv').config();

const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
const {
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI,
    PORT = 3000
} = process.env;

let REFRESH_TOKEN = process.env.REFRESH_TOKEN || '';

// ---------- STEP A: one-time login ----------
app.get('/login', (req, res) => {
    const scope = 'user-read-recently-played playlist-read-private';
    const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope,
        redirect_uri: REDIRECT_URI
    });
    res.redirect(authUrl);
});

// ---------- STEP B: Spotify redirects back here with a code ----------
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send('No code received. Try /login again.');

    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET
        })
    });

    const data = await tokenRes.json();

    if (data.refresh_token) {
        REFRESH_TOKEN = data.refresh_token;
        res.send(`
            <h2>Success!</h2>
            <p>Copy this into your .env as REFRESH_TOKEN:</p>
            <pre>${data.refresh_token}</pre>
        `);
    } else {
        res.send(`<pre>${JSON.stringify(data, null, 2)}</pre>`);
    }
});

// ---------- Helper: get a fresh access token using the refresh token ----------
async function getAccessToken() {
    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: REFRESH_TOKEN,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET
        })
    });

    const data = await res.json();

    if (data.error === 'invalid_grant') {
        throw new Error('REFRESH_TOKEN expired or invalid — go to /login again to get a new one.');
    }

    return data.access_token;
}

// ---------- STEP C: the actual quiz data endpoint ----------
app.get('/api/get-song-options', async (req, res) => {
    try {
        const accessToken = await getAccessToken();
        const headers = { Authorization: `Bearer ${accessToken}` };

        const recentRes = await fetch(
            'https://api.spotify.com/v1/me/player/recently-played?limit=1',
            { headers }
        );
        const recentData = await recentRes.json();
        console.log('recentData:', JSON.stringify(recentData, null, 2));

        if (!recentData.items || recentData.items.length === 0) {
            throw new Error('No recently played tracks found.');
        }
        const correctTrack = recentData.items[0].track;

        const playlistsRes = await fetch(
            'https://api.spotify.com/v1/me/playlists?limit=50',
            { headers }
        );
        const playlistsData = await playlistsRes.json();
        console.log('playlistsData:', JSON.stringify(playlistsData, null, 2));

        if (!playlistsData.items || playlistsData.items.length === 0) {
            throw new Error('No playlists found on this account.');
        }

       const meRes = await fetch('https://api.spotify.com/v1/me', { headers });
        const meData = await meRes.json();
        const myUserId = meData.id;
        console.log('My user ID:', myUserId);

        const ownedPlaylists = playlistsData.items.filter(
            p => p.owner && p.owner.id === myUserId
        );
       console.log('Owned playlists:', ownedPlaylists.map(p => `${p.name} (${p.tracks?.total ?? '?'} tracks)`));
        if (ownedPlaylists.length === 0) {
            throw new Error('No playlists owned by you were found — only followed/algorithmic ones.');
        }

        let candidateTracks = [];
        let attempts = 0;
        const shuffledPlaylists = [...ownedPlaylists].sort(() => Math.random() - 0.5);

        while (candidateTracks.length === 0 && attempts < shuffledPlaylists.length) {
            const playlist = shuffledPlaylists[attempts];
            attempts++;

            const tracksRes = await fetch(
    `https://api.spotify.com/v1/playlists/${playlist.id}/items?limit=50`,
    { headers }
);
            const tracksData = await tracksRes.json();

            if (tracksData.items) {
    candidateTracks = tracksData.items
        .map(item => item.item)
        .filter(t => t && t.id && t.id !== correctTrack.id);
    } else {
                console.log(`Skipped playlist "${playlist.name}" — error response:`, JSON.stringify(tracksData));
            }
        }

        if (candidateTracks.length === 0) {
            throw new Error('Could not find any usable tracks across your owned playlists.');
        }


        const wrongOptions = [];
        const usedIds = new Set();
        while (wrongOptions.length < 3 && candidateTracks.length > 0) {
            const pick = candidateTracks[Math.floor(Math.random() * candidateTracks.length)];
            if (!usedIds.has(pick.id)) {
                usedIds.add(pick.id);
                wrongOptions.push(pick);
            }
            if (usedIds.size >= candidateTracks.length) break;
        }

        res.json({
            correct: {
                id: correctTrack.id,
                name: correctTrack.name,
                artists: correctTrack.artists.map(a => ({ name: a.name })),
                album: { images: correctTrack.album.images }
            },
            wrongOptions: wrongOptions.map(t => ({
                id: t.id,
                name: t.name,
                artists: t.artists.map(a => ({ name: a.name })),
                album: { images: t.album.images }
            }))
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://127.0.0.1:${PORT}`);
    console.log(`If you don't have a REFRESH_TOKEN yet, go to http://127.0.0.1:${PORT}/login`);
});