/**
 * MPRIS Media Controller Plugin for SillyTavern
 * Controls any MPRIS-compatible media player via playerctl
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export const info = {
    id: 'mpris',
    name: 'MPRIS Media Controller',
    description: 'Control any MPRIS-compatible media player (Spotify, VLC, Firefox, etc.) via playerctl',
};

/**
 * Execute a playerctl command and return the output
 * @param {string} args - Arguments to pass to playerctl
 * @returns {Promise<string>} Command output
 */
async function playerctl(args) {
    try {
        const { stdout } = await execAsync(`playerctl ${args}`);
        return stdout.trim();
    } catch (error) {
        // playerctl returns exit code 1 when no player is found
        return null;
    }
}

/**
 * Get current playback status and track info
 * @returns {Promise<object>} Player state object
 */
async function getPlayerState() {
    try {
        // Get all metadata in JSON-like format
        const format = '{"title":"{{title}}","artist":"{{artist}}","album":"{{album}}","artUrl":"{{mpris:artUrl}}","position":"{{position}}","length":"{{mpris:length}}"}';
        const metadataRaw = await playerctl(`metadata --format '${format}'`);

        if (!metadataRaw) {
            return { playing: false, available: false };
        }

        // Get playback status separately (Playing, Paused, Stopped)
        const status = await playerctl('status');
        const isPlaying = status === 'Playing';

        // Parse the metadata
        let metadata;
        try {
            metadata = JSON.parse(metadataRaw);
        } catch {
            // Handle cases where metadata contains special characters
            metadata = {
                title: await playerctl('metadata title') || 'Unknown',
                artist: await playerctl('metadata artist') || 'Unknown',
                album: await playerctl('metadata album') || '',
                artUrl: await playerctl('metadata mpris:artUrl') || '',
            };
        }

        // Get position and length for progress bar
        // playerctl position returns seconds (float), mpris:length is in microseconds
        const positionSec = parseFloat(await playerctl('position') || '0');
        const lengthUs = parseInt(metadata.length || '0', 10);

        // Get shuffle and loop status
        const shuffleStatus = await playerctl('shuffle');
        const loopStatus = await playerctl('loop');

        return {
            available: true,
            playing: isPlaying,
            title: metadata.title || 'Unknown',
            artist: metadata.artist || 'Unknown',
            album: metadata.album || '',
            artUrl: metadata.artUrl || '',
            progress_ms: Math.floor(positionSec * 1000),
            duration_ms: Math.floor(lengthUs / 1000),
            shuffle: shuffleStatus === 'On',
            loop: loopStatus || 'None', // None, Track, or Playlist
        };
    } catch (error) {
        console.error('[MPRIS] Error getting player state:', error.message);
        return { playing: false, available: false, error: error.message };
    }
}

/**
 * Initialize the plugin and register routes
 * @param {import('express').Router} router - Express router for plugin routes
 */
export async function init(router) {
    console.log('[MPRIS] Initializing MPRIS Media Controller plugin...');

    // Check if playerctl is available
    try {
        await execAsync('which playerctl');
        console.log('[MPRIS] playerctl found, plugin ready.');
    } catch {
        console.error('[MPRIS] WARNING: playerctl not found! Install it with: sudo pacman -S playerctl (Arch) or sudo apt install playerctl (Debian/Ubuntu)');
    }

    // GET /api/plugins/mpris/status - Get current player state
    router.get('/status', async (req, res) => {
        const state = await getPlayerState();
        res.json(state);
    });

    // POST /api/plugins/mpris/play-pause - Toggle play/pause
    router.post('/play-pause', async (req, res) => {
        await playerctl('play-pause');
        res.json({ success: true });
    });

    // POST /api/plugins/mpris/play - Start playback
    router.post('/play', async (req, res) => {
        await playerctl('play');
        res.json({ success: true });
    });

    // POST /api/plugins/mpris/pause - Pause playback
    router.post('/pause', async (req, res) => {
        await playerctl('pause');
        res.json({ success: true });
    });

    // POST /api/plugins/mpris/next - Skip to next track
    router.post('/next', async (req, res) => {
        await playerctl('next');
        res.json({ success: true });
    });

    // POST /api/plugins/mpris/previous - Go to previous track
    router.post('/previous', async (req, res) => {
        await playerctl('previous');
        res.json({ success: true });
    });

    // POST /api/plugins/mpris/seek - Seek to position (in seconds)
    router.post('/seek', async (req, res) => {
        const { position } = req.body;
        if (typeof position === 'number') {
            await playerctl(`position ${position}`);
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Position required' });
        }
    });

    // POST /api/plugins/mpris/volume - Set volume (0.0 to 1.0)
    router.post('/volume', async (req, res) => {
        const { volume } = req.body;
        if (typeof volume === 'number') {
            await playerctl(`volume ${volume}`);
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Volume required' });
        }
    });

    // POST /api/plugins/mpris/shuffle - Toggle shuffle
    router.post('/shuffle', async (req, res) => {
        await playerctl('shuffle Toggle');
        res.json({ success: true });
    });

    // POST /api/plugins/mpris/loop - Cycle loop mode (None, Track, Playlist)
    router.post('/loop', async (req, res) => {
        // Get current loop status and cycle
        const current = await playerctl('loop');
        const modes = ['None', 'Track', 'Playlist'];
        const currentIndex = modes.indexOf(current);
        const nextMode = modes[(currentIndex + 1) % modes.length];
        await playerctl(`loop ${nextMode}`);
        res.json({ success: true, mode: nextMode });
    });

    // GET /api/plugins/mpris/players - List available players
    router.get('/players', async (req, res) => {
        const output = await playerctl('--list-all');
        const players = output ? output.split('\n').filter(p => p) : [];
        res.json({ players });
    });

    console.log('[MPRIS] Plugin routes registered at /api/plugins/mpris/');
}

export function exit() {
    console.log('[MPRIS] Plugin unloading...');
}
