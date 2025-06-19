const ariClient = require('ari-client');
const path = require('path');
const fs = require('fs');
const { exec, spawn, execSync } = require('child_process');
const dgram = require('dgram');
const WebSocket = require('ws');

// -------- TƏNZİMLƏMƏLƏR (DİQQƏT!) --------
const ASTERISK_URL = 'http://localhost:8088';
const ASTERISK_USERNAME = 'voicebot_user';         // Addım 1.2-də yaratdığınız istifadəçi adı
const ASTERISK_PASSWORD = 'SuperGucluParol123';    // Addım 1.2-də təyin etdiyiniz parol
const ARI_APP_NAME = 'voicebot_app';               // Addım 1.3-də istifadə etdiyiniz ad
const WEBSOCKET_URL = 'ws://46.62.130.51:3001';   // Qoşulacağımız WebSocket serveri
const EXTERNAL_MEDIA_UDP_PORT = 10000;             // Səs axını üçün istifadə ediləcək lokal UDP portu

const SOUNDS_DIR = path.join(__dirname, 'sounds');

// Səsləri hazırlayan funksiya
function setupSounds() {
    if (!fs.existsSync(SOUNDS_DIR)) {
        fs.mkdirSync(SOUNDS_DIR, { recursive: true });
        console.log(`Səslər üçün qovluq yaradıldı: ${SOUNDS_DIR}`);
    }

    const welcomeSound = path.join(SOUNDS_DIR, 'welcome.wav');
    const goodbyeSound = path.join(SOUNDS_DIR, 'goodbye.wav');

    if (!fs.existsSync(welcomeSound)) {
        console.warn(`${welcomeSound} tapılmadı. Test səsi yaradılır...`);
        exec(`sox -n -r 8000 -c 1 ${welcomeSound} synth 0.8 sine 440 vol 0.5`);
    }
    if (!fs.existsSync(goodbyeSound)) {
        console.warn(`${goodbyeSound} tapılmadı. Test səsi yaradılır...`);
        exec(`sox -n -r 8000 -c 1 ${goodbyeSound} synth 0.8 sine 660 vol 0.5`);
    }
    
    // Bu əmrin uğurlu olması üçün skriptin sudo ilə və ya asterisk istifadəçisi kimi işə salınması tövsiyə olunur.
    // Əks halda, /etc/asterisk/asterisk.conf faylında `astspooldir` qovluğunu dəyişib
    // asterisk istifadəçisinin yazma icazəsi olan bir yerə təyin edin.
    console.log(`Asterisk istifadəçisinin "${SOUNDS_DIR}" qovluğuna yazma və oxuma icazəsi olduğundan əmin olun.`);
    exec(`chown -R asterisk:asterisk ${SOUNDS_DIR}`, (err, stdout, stderr) => {
        if (err) {
            console.warn(`⚠️  'chown' əmri uğursuz oldu. Səs fayllarını oxumaq üçün Asterisk-in icazəsi olmaya bilər. Detallar: ${err.message}`);
        } else {
            console.log(`✅  '${SOUNDS_DIR}' qovluğunun sahibi 'asterisk:asterisk' olaraq təyin edildi.`);
        }
    });
}

// Hər bir aktiv zəng üçün səs axını resurslarını saxlayan obyekt
const callStates = new Map();

// Səs axını ilə bağlı resursları (sox prosesi, named pipe) təmizləyən funksiya
async function cleanupPlaybackResources(channelId) {
    if (callStates.has(channelId)) {
        console.log(`[${channelId}] Səs axını resursları təmizlənir...`);
        const state = callStates.get(channelId);
        
        // Davam edən səsləndirməni dayandırırıq
        if (state.playback && !state.playback.destroyed) {
            try {
                await state.playback.stop();
                console.log(`[${channelId}] Səsləndirmə dayandırıldı.`);
            } catch (e) {
                // Səsləndirmə artıq bitibsə xəta verə bilər, normaldır.
            }
        }

        // sox prosesini dayandırırıq
        if (state.soxProcess) {
            state.soxProcess.kill('SIGTERM');
            console.log(`[${channelId}] sox prosesi dayandırıldı.`);
        }

        // Yaradılmış named pipe faylını silirik
        if (state.pipePath && fs.existsSync(state.pipePath)) {
            fs.unlinkSync(state.pipePath);
            console.log(`[${channelId}] Named pipe (${state.pipePath}) silindi.`);
        }
        
        callStates.delete(channelId);
    }
}

// Əsas ARI məntiqi
async function main() {
    try {
        setupSounds();

        const client = await ariClient.connect(ASTERISK_URL, ASTERISK_USERNAME, ASTERISK_PASSWORD);
        console.log('✅ ARI-yə uğurla qoşuldu.');

        // Səs axınını qəbul etmək üçün UDP server yaradırıq
        const udpServer = dgram.createSocket('udp4');
        let ws; // WebSocket
        let externalChannel;

        udpServer.on('error', (err) => {
            console.error(`UDP Server xətası:\n${err.stack}`);
            udpServer.close();
        });

        udpServer.on('message', (msg, rinfo) => {
            // Asteriskdən gələn RTP paketlərinin ilk 12 baytı başlıqdır, sonrası isə xalis səs datasıdır (raw SLIN).
            const audioChunk = msg.slice(12);
            if (ws && ws.readyState === WebSocket.OPEN) {
                // index.tsx 16-bit PCM (Int16) data göndərir, biz də eyni formatda göndəririk.
                ws.send(audioChunk);
            }
        });

        udpServer.bind(EXTERNAL_MEDIA_UDP_PORT, '127.0.0.1');
        console.log(`🎧 UDP server ${EXTERNAL_MEDIA_UDP_PORT} portunda səsləri dinləyir...`);

        client.on('StasisStart', async (event, channel) => {
            console.log(`📞 Yeni zəng qəbul edildi: ${channel.id}`);
            try {
                await channel.answer();
                console.log(`📢 Zəngə cavab verildi: ${channel.id}`);

                // Hər zəng üçün yeni WebSocket bağlantısı qururuq
                ws = new WebSocket(WEBSOCKET_URL);

                ws.on('open', async () => {
                    console.log(`[${channel.id}] ✅ WebSocket-a uğurla qoşuldu.`);
                    // Zəngin səsini lokal UDP serverimizə yönləndirmək üçün externalMedia kanalı yaradırıq
                    externalChannel = client.Channel();
                    const externalMediaOptions = {
                        app: ARI_APP_NAME,
                        external_host: `127.0.0.1:${EXTERNAL_MEDIA_UDP_PORT}`,
                        format: 'slin16' // 16kHz, 16-bit linear PCM. index.tsx-ə uyğun
                    };
                    
                    console.log('Səs axını üçün external media kanalı yaradılır...');
                    await externalChannel.externalMedia(externalMediaOptions);
                    console.log('✅ External media kanalı uğurla yaradıldı.');

                    // Gələn zəngi bu kanala körpüləyirik ki, səs axını başlasın
                    const bridge = client.Bridge();
                    await bridge.create({ type: 'mixing' });
                    await bridge.addChannel({ channel: [channel.id, externalChannel.id] });
                    console.log(`[${channel.id}] ✅ Zəng və external media kanalı körpüləndi. Səs axını başladı.`);
                });

                ws.on('message', async (data) => {
                    try {
                        const message = JSON.parse(data);
                        
                        // Servisdən gələn "interrupted" siqnalını emal edirik
                        if (message.data.serverContent?.interrupted) {
                            console.log(`[${channel.id}] 🛑 Servisdən 'interrupted' siqnalı gəldi. Mövcud səs axını dayandırılır.`);
                            await cleanupPlaybackResources(channel.id);
                            return;
                        }

                        const audioDataBase64 = message.data.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        
                        if (audioDataBase64) {
                            const audioBuffer = Buffer.from(audioDataBase64, 'base64');
                            
                            // Əgər bu zəng üçün aktiv səs axını yoxdursa, yenisini yaradırıq
                            if (!callStates.has(channel.id)) {
                                console.log(`[${channel.id}] 🎶 Yeni səs axını başladılır...`);
                                const pipePath = path.join(SOUNDS_DIR, `playback_${channel.id}.sln16`);
                                
                                // Əvvəlki zəngdən qala biləcək köhnə pipe faylını silirik
                                if (fs.existsSync(pipePath)) fs.unlinkSync(pipePath);

                                // Named pipe (FIFO) yaradırıq
                                execSync(`mkfifo ${pipePath}`);
                                
                                // sox prosesini daimi axın üçün başladırıq
                                const soxProcess = spawn('sox', [
                                    '-t', 'raw', '-r', '24000', '-e', 'signed-integer', '-b', '16', '-c', '1', '-', // Giriş: stdin, 24kHz
                                    '-t', 'raw', '-r', '16000', '-e', 'signed-integer', '-b', '16', '-c', '1', pipePath // Çıxış: named pipe, 16kHz
                                ]);

                                soxProcess.stderr.on('data', (data) => {
                                    console.error(`[${channel.id}] sox XƏTA: ${data}`);
                                });

                                // Asterisk üçün səsləndirmə obyektini yaradırıq
                                const playback = client.Playback();
                                
                                // Zəng üçün state-i saxlayırıq
                                callStates.set(channel.id, { soxProcess, pipePath, playback });
                                
                                console.log(`[${channel.id}] Asterisk-ə səsləndirmə üçün müraciət edilir: ${pipePath}`);
                                // Səsləndirməni arxa fonda başladırıq. play() faylı oxumağa başlayacaq.
                                channel.play({ media: `sound:${path.basename(pipePath, '.sln16')}`, playbackId: playback.id })
                                    .catch(err => {
                                        console.error(`[${channel.id}] Səsləndirmə zamanı xəta:`, err.message);
                                    })
                                    .finally(async () => {
                                        console.log(`[${channel.id}] Səsləndirmə təbii olaraq bitdi və ya dayandırıldı.`);
                                        await cleanupPlaybackResources(channel.id);
                                    });
                                
                                // Səsləndirmənin başlaması üçün qısa bir fasilə veririk
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            
                            // Gələn audio parçasını aktiv sox prosesinin girişinə yazırıq
                            const state = callStates.get(channel.id);
                            if (state && state.soxProcess && !state.soxProcess.killed) {
                                state.soxProcess.stdin.write(audioBuffer);
                            }
                        }
                    } catch (e) {
                        console.error(`[${channel.id}] WebSocket-dan gələn mesajı emal edərkən xəta:`, e.message);
                    }
                });

                ws.on('close', async () => {
                    console.log(`[${channel.id}] WebSocket bağlantısı bağlandı.`);
                    // Zəng hələ aktivdirsə bitiririk
                    if (!channel.destroyed) {
                        await channel.hangup();
                    }
                });

                ws.on('error', async (err) => {
                    console.error(`[${channel.id}] ❌ WebSocket xətası:`, err.message);
                    if (!channel.destroyed) {
                        await channel.hangup();
                    }
                });

            } catch (err) {
                console.error(`❌ Kanal ${channel.id} üçün xəta:`, err.message);
                if (!channel.destroyed) {
                    await channel.hangup();
                }
            }
        });

        client.on('StasisEnd', async (event, channel) => {
            console.log(`📴 Zəng bitirildi: ${channel.id}`);
            // WebSocket və digər resursları təmizlə
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
            if (externalChannel && !externalChannel.destroyed) {
                await externalChannel.hangup();
            }
            // Səs axını ilə bağlı bütün resursları təmizləyirik
            await cleanupPlaybackResources(channel.id);
        });

        await client.start(ARI_APP_NAME);
        console.log(`👂 '${ARI_APP_NAME}' tətbiqi üçün zənglər gözlənilir...`);

    } catch (err) {
        console.error('❌ ARI-yə qoşularkən kritik xəta baş verdi:', err.message);
        console.error('💡 Yoxlayın: FreePBX-də ARI aktivdirmi? İstifadəçi adı/parol düzgündürmü?');
    }
}

main();