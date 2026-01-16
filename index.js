
import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
// toastr is global

const extensionName = "ST-BasicSpotify";
const defaultSettings = {
    clientId: '',
    accessToken: '',
    refreshToken: '',
    tokenExpiry: 0,
    enablePanel: true,
    useMpris: true, // Default to MPRIS (local control, no API key needed)
};

let settings = Object.assign({}, defaultSettings);
let pollingInterval = null;

// HTML Elements
let playerPanel = null;

/**
 * Format milliseconds to mm:ss
 */
function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

async function loadSettings() {
    settings = Object.assign({}, defaultSettings, extension_settings[extensionName]);
}

function saveSettings() {
    extension_settings[extensionName] = settings;
    saveSettingsDebounced();
}

// =============================================================================
// AUTHENTICATION (PKCE)
// =============================================================================

function generateRandomString(length) {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

async function generateCodeChallenge(codeVerifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode.apply(null, [...new Uint8Array(digest)]))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

async function initiateAuth() {
    if (!settings.clientId) {
        toastr.warning("Please enter a Client ID in the settings first.");
        return;
    }

    const codeVerifier = generateRandomString(128);
    localStorage.setItem('spotify_code_verifier', codeVerifier);

    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateRandomString(16);
    const scope = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
    // Removed protocol from redirectUri to be flexible, but Spotify requires exact match.
    // Assuming standard ST running on localhost:8000 for now, or user configured.
    const redirectUri = window.location.origin + '/';

    const args = new URLSearchParams({
        response_type: 'code',
        client_id: settings.clientId,
        scope: scope,
        redirect_uri: redirectUri,
        state: state,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge
    });

    window.open('https://accounts.spotify.com/authorize?' + args, '_blank', 'width=500,height=600');

    // Listen for the callback (hacky but works for extensions without backend)
    // The popup will redirect to window.location.origin/?code=...
    // We can't easily intercept that in the main window unless we are the parent.
    // Standard ST extensions often use a manual "Paste Code" or a custom local server.
    // However, if we use the popup approach, the user sees ST open in the popup.
    // A better way for *client-side only* is "Implicit Grant" but that's deprecated.
    // PKCE is standard.

    // Strategy: The popup will load SillyTavern. We need to detect if we are IN the popup and just grabbed the code.
    // BUT index.js runs in the main window.
    // If the user authenticates in the popup, the popup will eventually redirect to localhost:8000/?code=...
    // We can ask the user to copy the URL code, OR we can try to listen to message events if we are same-origin.

    window.addEventListener('message', async (event) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'spotify-auth-code') {
            const code = event.data.code;
            if (code) {
                await exchangeCodeForToken(code);
            }
        }
    });

    toastr.info("After authorizing, if the popup doesn't close automatically, please look for the 'Success' message.");
}

// This function checks URL params on load to see if we are the redirect target
async function checkAuthRedirect() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');

    // If we have a code and we have a verifier in storage, we are likely the auth popup
    if (code && localStorage.getItem('spotify_code_verifier')) {
        // Send code to opener
        if (window.opener) {
            window.opener.postMessage({ type: 'spotify-auth-code', code: code }, window.location.origin);
            window.close();
        } else {
            // Fallback: If for some reason we aren't a popup (user navigated main tab), handle it here
            await exchangeCodeForToken(code);
            // Clear URL
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }
}

async function exchangeCodeForToken(code) {
    const codeVerifier = localStorage.getItem('spotify_code_verifier');
    const redirectUri = window.location.origin + '/';

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: settings.clientId,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier,
            }),
        });

        const data = await response.json();

        if (data.access_token) {
            settings.accessToken = data.access_token;
            settings.refreshToken = data.refresh_token;
            settings.tokenExpiry = Date.now() + (data.expires_in * 1000);
            saveSettings();
            toastr.success("Connected to Spotify successfully!");
            updateSettingsStatus();
            startPolling();
        } else {
            console.error("Spotify Auth Error:", data);
            toastr.error("Failed to authenticate with Spotify.");
        }
    } catch (err) {
        console.error(err);
        toastr.error("Network error during Spotify authentication.");
    }
}

async function refreshAccessToken() {
    if (!settings.refreshToken || !settings.clientId) return false;

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: settings.clientId,
                grant_type: 'refresh_token',
                refresh_token: settings.refreshToken,
            }),
        });

        const data = await response.json();
        if (data.access_token) {
            settings.accessToken = data.access_token;
            if (data.refresh_token) settings.refreshToken = data.refresh_token;
            settings.tokenExpiry = Date.now() + (data.expires_in * 1000);
            saveSettings();
            return true;
        } else {
            console.warn("Failed to refresh token", data);
            toastr.warning("Spotify session expired. Please reconnect.");
            return false;
        }
    } catch (err) {
        console.error(err);
        return false;
    }
}

async function getValidToken() {
    if (!settings.accessToken) return null;
    if (Date.now() > settings.tokenExpiry - 60000) {
        if (await refreshAccessToken()) {
            return settings.accessToken;
        } else {
            return null;
        }
    }
    return settings.accessToken;
}

// =============================================================================
// PLAYER LOGIC
// =============================================================================

async function fetchPlayerState() {
    // Use MPRIS if enabled
    if (settings.useMpris) {
        return await fetchMprisState();
    }

    // Fallback to Spotify API
    const token = await getValidToken();
    if (!token) return null;

    try {
        const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 204) {
            return null; // No content, not playing
        }

        if (response.status !== 200) {
            throw new Error(`Status ${response.status}`);
        }

        return await response.json();
    } catch (err) {
        console.error('Spotify Player Fetch Error:', err);
        return null;
    }
}

async function controlPlayer(command, method = 'POST') {
    // Use MPRIS if enabled
    if (settings.useMpris) {
        return await controlMpris(command);
    }

    // Fallback to Spotify API
    const token = await getValidToken();
    if (!token) {
        toastr.warning('Not connected to Spotify.');
        return;
    }

    try {
        const url = `https://api.spotify.com/v1/me/player/${command}`;
        const response = await fetch(url, {
            method: method,
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 403) {
            toastr.error("Spotify Premium required for controls (or no active device found).");
        } else if (response.status === 404) {
            toastr.warning("No active Spotify device found. Start playback on a device first.");
        } else if (response.status !== 204) { // 204 No Content is success for some commands
            throw new Error(`Status ${response.status}`);
        }

    } catch (err) {
        console.error('Spotify control error:', err);
        toastr.error('Failed to send command.');
    }
}

/**
 * Control player via MPRIS plugin
 */
async function controlMpris(command) {
    // Map Spotify API commands to MPRIS endpoints
    const commandMap = {
        'play': 'play',
        'pause': 'pause',
        'next': 'next',
        'previous': 'previous',
    };

    const mprisCommand = commandMap[command] || 'play-pause';

    try {
        const response = await fetch(`/api/plugins/mpris/${mprisCommand}`, {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!response.ok) {
            toastr.warning('MPRIS plugin not available.');
        }
    } catch (err) {
        console.error('MPRIS control error:', err);
        toastr.error('Failed to control player.');
    }
}

/**
 * Fetch player state from MPRIS plugin
 */
async function fetchMprisState() {
    try {
        const response = await fetch('/api/plugins/mpris/status');
        if (!response.ok) {
            console.warn('MPRIS plugin not available. Is enableServerPlugins: true in config.yaml?');
            return null;
        }
        const data = await response.json();
        if (!data.available) return null;

        // Convert to Spotify API-like format for compatibility
        return {
            is_playing: data.playing,
            item: {
                name: data.title,
                artists: [{ name: data.artist }],
                album: {
                    images: data.artUrl ? [{ url: data.artUrl }] : [],
                },
                duration_ms: data.duration_ms || 0,
            },
            progress_ms: data.progress_ms || 0,
            shuffle: data.shuffle || false,
            loop: data.loop || 'None',
        };
    } catch (err) {
        console.error('MPRIS Fetch Error:', err);
        return null;
    }
}

/**
 * Seek to a specific position in seconds
 */
async function seekToPosition(positionSec) {
    if (settings.useMpris) {
        try {
            const response = await fetch('/api/plugins/mpris/seek', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ position: positionSec }),
            });
            if (!response.ok) {
                toastr.warning('Seek not supported');
            }
        } catch (err) {
            console.error('Seek error:', err);
        }
    }
    // For Spotify API, seek is more complex and requires device ID, skip for now
}

// =============================================================================
// UI CONSTRUCTION
// =============================================================================

function createPlayerPanel() {
    if (document.getElementById('spotify-player-sidebar')) return;

    playerPanel = document.createElement('div');
    playerPanel.id = 'spotify-player-sidebar';
    playerPanel.className = 'spotify-player-sidebar';
    playerPanel.dataset.durationMs = '0'; // Store duration for seek calculations

    // Check if previously collapsed
    if (localStorage.getItem('spotify_sidebar_collapsed') === 'true') {
        playerPanel.classList.add('collapsed');
    }

    playerPanel.innerHTML = `
        <div class="spotify-header">
            <div class="spotify-brand">
                <i class="fa-brands fa-spotify spotify-icon"></i>
                <span>Music</span>
            </div>
            <button class="spotify-collapse-btn" id="spotify_collapse_btn" title="Toggle View">
               <i class="fa-solid fa-chevron-left"></i>
            </button>
        </div>
        <div class="spotify-track-info">
            <img src="" class="spotify-album-art" id="spotify_art_img" onerror="this.style.display='none'">
            <div class="spotify-track-details">
                <div class="spotify-track-name" id="spotify_track_name">Not Playing</div>
                <div class="spotify-artist-name" id="spotify_artist_name">--</div>
            </div>
        </div>
        <div class="spotify-progress-bar-container" id="spotify_progress_container" title="Click to seek">
            <div class="spotify-progress-bar-fill" id="spotify_progress_bar"></div>
        </div>
        <div class="spotify-time-display">
            <span id="spotify_time_current">0:00</span>
            <span id="spotify_time_duration">0:00</span>
        </div>
        <div class="spotify-controls">
            <button class="spotify-btn small" id="spotify_shuffle_btn" title="Shuffle"><i class="fa-solid fa-shuffle"></i></button>
            <button class="spotify-btn" id="spotify_prev_btn" title="Previous"><i class="fa-solid fa-backward-step"></i></button>
            <button class="spotify-btn play-pause" id="spotify_play_pause_btn" title="Play/Pause"><i class="fa-solid fa-play"></i></button>
            <button class="spotify-btn" id="spotify_next_btn" title="Next"><i class="fa-solid fa-forward-step"></i></button>
            <button class="spotify-btn small" id="spotify_loop_btn" title="Repeat"><i class="fa-solid fa-repeat"></i></button>
        </div>
    `;

    document.body.appendChild(playerPanel);

    // Bind Controls
    playerPanel.querySelector('#spotify_prev_btn').addEventListener('click', () => controlPlayer('previous'));
    playerPanel.querySelector('#spotify_next_btn').addEventListener('click', () => controlPlayer('next'));
    playerPanel.querySelector('#spotify_play_pause_btn').addEventListener('click', async () => {
        const state = await fetchPlayerState();
        if (state && state.is_playing) {
            controlPlayer('pause', 'PUT');
        } else {
            controlPlayer('play', 'PUT');
        }
        updatePlayerUI();
    });

    // Shuffle button
    playerPanel.querySelector('#spotify_shuffle_btn').addEventListener('click', async () => {
        try {
            const response = await fetch('/api/plugins/mpris/shuffle', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            if (response.ok) {
                toastr.info('Shuffle toggled');
            }
        } catch (err) {
            console.error('Shuffle error:', err);
        }
    });

    // Loop button
    playerPanel.querySelector('#spotify_loop_btn').addEventListener('click', async () => {
        try {
            const response = await fetch('/api/plugins/mpris/loop', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            if (response.ok) {
                const data = await response.json();
                toastr.info(`Repeat: ${data.mode || 'Changed'}`);
            }
        } catch (err) {
            console.error('Loop error:', err);
        }
    });

    // Seek bar click handler
    playerPanel.querySelector('#spotify_progress_container').addEventListener('click', async (e) => {
        const container = e.currentTarget;
        const rect = container.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const percent = clickX / rect.width;
        const durationMs = parseInt(playerPanel.dataset.durationMs || '0', 10);

        if (durationMs > 0) {
            const seekPositionSec = (percent * durationMs) / 1000;
            await seekToPosition(seekPositionSec);
            // Update UI immediately for feedback
            const progressBar = document.getElementById('spotify_progress_bar');
            if (progressBar) progressBar.style.width = `${percent * 100}%`;
        }
    });

    // Collapse Button Logic
    playerPanel.querySelector('#spotify_collapse_btn').addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent double-toggle when expanded
        toggleCollapse();
    });

    // Also allow clicking on the entire collapsed pill to expand
    playerPanel.addEventListener('click', (e) => {
        if (playerPanel.classList.contains('collapsed')) {
            toggleCollapse();
        }
    });

    function toggleCollapse() {
        playerPanel.classList.toggle('collapsed');
        const isCollapsed = playerPanel.classList.contains('collapsed');
        playerPanel.querySelector('#spotify_collapse_btn i').className = isCollapsed ? 'fa-brands fa-spotify' : 'fa-solid fa-chevron-left';
        localStorage.setItem('spotify_sidebar_collapsed', String(isCollapsed));
    }

    // Initial collapse icon state
    if (playerPanel.classList.contains('collapsed')) {
        playerPanel.querySelector('#spotify_collapse_btn i').className = 'fa-brands fa-spotify';
    }
}

function removePlayerPanel() {
    if (playerPanel) {
        playerPanel.remove();
        playerPanel = null;
    }
}

async function updatePlayerUI() {
    if (!settings.enablePanel) {
        removePlayerPanel();
        return;
    }

    // If panel is missing but enabled, create it
    if (!playerPanel && settings.enablePanel) {
        createPlayerPanel();
    }

    const data = await fetchPlayerState();

    const artImg = document.getElementById('spotify_art_img');
    const trackName = document.getElementById('spotify_track_name');
    const artistName = document.getElementById('spotify_artist_name');
    const playPauseBtn = document.getElementById('spotify_play_pause_btn');
    const progressBar = document.getElementById('spotify_progress_bar');

    // Update container class for collapse state if needed (handled by button mostly, but good to sync)

    if (!data || !data.item) {
        if (trackName) trackName.textContent = 'Not Playing';
        if (artistName) artistName.textContent = 'Start Spotify on a device';
        if (artImg) artImg.style.display = 'none';
        return;
    }

    if (trackName) trackName.textContent = data.item.name;
    if (artistName) artistName.textContent = data.item.artists.map(a => a.name).join(', ');

    if (artImg && data.item.album.images.length > 0) {
        artImg.src = data.item.album.images[0].url;
        artImg.style.display = 'block';
    }

    if (playPauseBtn) {
        playPauseBtn.innerHTML = data.is_playing ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
    }

    if (progressBar && data.item.duration_ms) {
        const percent = (data.progress_ms / data.item.duration_ms) * 100;
        progressBar.style.width = `${percent}%`;
        // Store duration for seek bar click calculations
        if (playerPanel) {
            playerPanel.dataset.durationMs = String(data.item.duration_ms);
        }

        // Update time display
        const timeCurrent = document.getElementById('spotify_time_current');
        const timeDuration = document.getElementById('spotify_time_duration');
        if (timeCurrent) timeCurrent.textContent = formatTime(data.progress_ms);
        if (timeDuration) timeDuration.textContent = formatTime(data.item.duration_ms);
    }

    // Update shuffle/loop button active states
    const shuffleBtn = document.getElementById('spotify_shuffle_btn');
    const loopBtn = document.getElementById('spotify_loop_btn');

    if (shuffleBtn) {
        if (data.shuffle) {
            shuffleBtn.classList.add('active');
        } else {
            shuffleBtn.classList.remove('active');
        }
    }

    if (loopBtn) {
        if (data.loop && data.loop !== 'None') {
            loopBtn.classList.add('active');
            // Show different icon for track repeat vs playlist repeat
            if (data.loop === 'Track') {
                loopBtn.innerHTML = '<i class="fa-solid fa-repeat"></i><span class="repeat-one">1</span>';
            } else {
                loopBtn.innerHTML = '<i class="fa-solid fa-repeat"></i>';
            }
        } else {
            loopBtn.classList.remove('active');
            loopBtn.innerHTML = '<i class="fa-solid fa-repeat"></i>';
        }
    }
}

function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(updatePlayerUI, 1000); // Poll every 1 second
    updatePlayerUI();
}

function stopPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = null;
}

// =============================================================================
// SETTINGS
// =============================================================================

function updateSettingsStatus() {
    const statusEl = document.getElementById('spotify_connection_status');
    const connectBtn = document.getElementById('spotify_connect_btn');
    const disconnectBtn = document.getElementById('spotify_disconnect_btn');

    if (settings.accessToken && statusEl) {
        statusEl.textContent = "Connected";
        statusEl.className = "spotify-status-connected";
        if (connectBtn) connectBtn.style.display = 'none';
        if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
    } else if (statusEl) {
        statusEl.textContent = "Disconnected";
        statusEl.className = "spotify-status-disconnected";
        if (connectBtn) connectBtn.style.display = 'inline-block';
        if (disconnectBtn) disconnectBtn.style.display = 'none';
    }
}

function onSettingsChanged() {
    settings.clientId = document.getElementById('spotify_client_id').value;
    settings.enablePanel = document.getElementById('spotify_enable_panel').checked;
    saveSettings();
    updatePlayerUI();
}

jQuery(async () => {
    // Check if we are a redirect child first
    await checkAuthRedirect();

    await loadSettings();

    // Load and inject settings.html into the Extensions settings panel
    const extensionFolderPath = 'scripts/extensions/third-party/SillyTavern-Spotify';
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);

        // Now that settings are injected, populate the form values
        const clientIdInput = document.getElementById('spotify_client_id');
        const enablePanelInput = document.getElementById('spotify_enable_panel');
        const useMprisInput = document.getElementById('spotify_use_mpris');
        const apiSettingsPanel = document.getElementById('spotify_api_settings');

        if (clientIdInput) clientIdInput.value = settings.clientId || '';
        if (enablePanelInput) enablePanelInput.checked = settings.enablePanel;
        if (useMprisInput) useMprisInput.checked = settings.useMpris !== false; // Default to true

        // Toggle API settings visibility based on mode
        function updateApiSettingsVisibility() {
            if (apiSettingsPanel) {
                apiSettingsPanel.style.display = settings.useMpris ? 'none' : 'block';
            }
        }
        updateApiSettingsVisibility();

        updateSettingsStatus();
    } catch (err) {
        console.error('Spotify Extension: Failed to load settings.html', err);
    }

    $(document).on('click', '#spotify_connect_btn', initiateAuth);
    $(document).on('click', '#spotify_disconnect_btn', () => {
        settings.accessToken = "";
        settings.refreshToken = "";
        settings.tokenExpiry = 0;
        saveSettings();
        updateSettingsStatus();
        stopPolling();
        removePlayerPanel();
        toastr.info("Disconnected from Spotify.");
    });

    $(document).on('change', '#spotify_client_id', onSettingsChanged);
    $(document).on('change', '#spotify_enable_panel', onSettingsChanged);

    // Handler for MPRIS toggle
    $(document).on('change', '#spotify_use_mpris', function () {
        settings.useMpris = this.checked;
        saveSettings();

        // Toggle API settings visibility
        const apiSettingsPanel = document.getElementById('spotify_api_settings');
        if (apiSettingsPanel) {
            apiSettingsPanel.style.display = settings.useMpris ? 'none' : 'block';
        }

        // Restart polling with new mode
        stopPolling();
        if (settings.enablePanel) {
            startPolling();
        }
    });

    // Inject into the right panel by default if enabled
    if (settings.enablePanel) {
        createPlayerPanel();
    }

    // Start polling - works for both MPRIS and Spotify API
    if (settings.useMpris || settings.accessToken) {
        startPolling();
    }

    // Attempt to add menu button with retries
    let retryCount = 0;
    const interval = setInterval(() => {
        if (document.getElementById('spotify_menu_btn')) {
            clearInterval(interval);
            return;
        }

        // Try adding
        addExtensionsMenuButton();

        // Check if successful
        if (document.getElementById('spotify_menu_btn')) {
            clearInterval(interval);
        } else {
            retryCount++;
            if (retryCount > 10) { // Stop after 10 seconds
                clearInterval(interval);
                console.warn('Spotify Extension: Could not find extensions menu to attach button.');
            }
        }
    }, 1000);
});

function addExtensionsMenuButton() {
    // Check if button already exists
    if (document.getElementById('spotify_menu_btn')) return;

    // Try to find the extensions menu container
    // Common selectors used by other extensions
    const selectors = ['#extensionsMenu', '#extensions-menu', '#extensionsList', '#extensionsMenuContainer', '#extensions_menu'];
    let container = null;
    for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
            container = el;
            break;
        }
    }

    if (!container) return;

    const btn = document.createElement('div');
    btn.id = 'spotify_menu_btn';
    btn.className = 'list-group-item flex-container flexGap5';
    btn.innerHTML = `
        <div class="fa-brands fa-spotify extensionsMenuExtensionButton"></div>
        <div class="flex1">Spotify Player</div>
    `;

    btn.addEventListener('click', () => {
        togglePlayer();
    });

    container.appendChild(btn);
}

function togglePlayer() {
    settings.enablePanel = !settings.enablePanel;
    saveSettings();
    updatePlayerUI(); // Will create or remove panel
    // Also update the checkbox in settings if it exists
    const checkbox = document.getElementById('spotify_enable_panel');
    if (checkbox) checkbox.checked = settings.enablePanel;
}
