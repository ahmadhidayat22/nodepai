const axios = require('axios');
const crypto = require('crypto'); // Masih diperlukan jika Anda perlu randomBytes untuk uid fallback
const ProxyChecker = require('./proxyChecker');
const { v4: uuidv4 } = require('uuid'); // Impor uuidv4 dari pustaka uuid
const { CookieJar } = require('tough-cookie');
// const { wrapper } = require('axios-cookiejar-support');

let axiosWrapperInitialized = false;
let cookieJarInstance;

class Bot {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.proxyCheck = new ProxyChecker(config, logger);
    // Inisialisasi browserId di constructor, ini akan digunakan secara konsisten
    // untuk setiap instance bot (setiap akun).
    // Jika Anda ingin browserId yang sama untuk semua bot, pindahkan ini ke luar kelas Bot.
    this.browserId = uuidv4(); // Generate UUID sekali per instance Bot
    this.jar = new CookieJar();
    
    // Inisialisasi CookieJar di constructor
    this.cookieJar = new CookieJar();

    // Instance Axios awal tanpa wrapper.
    // Kita akan membungkusnya dengan wrapper secara asinkron saat pertama kali digunakan.
    this.axiosInstance = axios.create();
  }
  async initializeAxiosWrapper() {
    if (!axiosWrapperInitialized) {
      // Menggunakan import() dinamis untuk memuat modul ESM
      const { wrapper } = await import('axios-cookiejar-support');
      // Membungkus instance axios yang sudah ada
      this.axiosInstance = wrapper(this.axiosInstance, this.cookieJar);
      axiosWrapperInitialized = true;
    }
  }

  async connect(token, proxy = null) {
    try {
      await this.initializeAxiosWrapper();

      // User-Agent yang lebih realistis dan umum
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

      // Pastikan sesi didapatkan dengan token yang benar
      const accountInfo = await this.getSession(token, userAgent, proxy);

      console.log(
        `✅ ${'Connected to session'.green} for UID: ${accountInfo.uid}`
      );
      this.logger.info('Session info', {
        uid: accountInfo.uid,
        name: accountInfo.name,
        useProxy: !!proxy,
      });

      console.log('');

      // Mengatur interval ping
      // Menggunakan `this.pingTimeout` untuk manajemen interval
      // agar bisa di-clear di tempat lain jika diperlukan (misalnya di main.js jika ada logic logout)
      if (this.pingInterval) {
          clearInterval(this.pingInterval); // Pastikan interval sebelumnya di-clear jika ada
      }
      this.pingInterval = setInterval(async () => {
        try {
          await this.sendPing(accountInfo, token, userAgent, proxy);
        } catch (error) {
          console.log(`❌ ${'Ping error'.red} for UID ${accountInfo.uid}: ${error.message}`);
          this.logger.error('Ping error', { uid: accountInfo.uid, error: error.message });
        }
      }, this.config.retryInterval); // Pastikan config.retryInterval terdefinisi di Config class

      // Penanganan SIGINT (Ctrl+C) yang lebih terisolasi untuk bot ini jika diperlukan
      // Namun, lebih baik ditangani di `index.js` untuk meng-clear semua interval bot.
      // Jika Anda ingin setiap bot mengelola SIGINT-nya sendiri, pastikan listener hanya dipasang sekali.
      // Untuk banyak bot, listener tunggal di index.js lebih efisien.
      // Saya akan tinggalkan di sini, tapi ingat potensi duplikasi listener.
      if (!process.listenerCount('SIGINT')) {
        process.once('SIGINT', () => {
          clearInterval(this.pingInterval);
          console.log('\n👋 Shutting down...'); // Ini akan dipanggil sekali untuk semua bot
        });
      }

    } catch (error) {
      console.log(`❌ ${'Connection error'.red}: ${error.message}`);
      this.logger.error('Connection error', { error: error.message, proxy });
    }
  }

  async getSession(token, userAgent, proxy) {
    try {
      const requestConfig = { // Ganti 'config' menjadi 'requestConfig' agar tidak konflik dengan 'this.config'
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
      };

      if (proxy) {
        requestConfig.proxy = this.buildProxyConfig(proxy);
      }

      // Pastikan sessionURL diatur dengan benar di objek config yang diinisialisasi di index.js
      // const response = await axios.post(this.config.sessionURL, {}, config);
      const response = await this.axiosInstance.post(this.config.sessionURL, {}, requestConfig); // Gunakan this.axiosInstance

      // Periksa struktur respons yang benar
      if (response.data && response.data.data && response.data.data.uid) {
          return response.data.data;
      } else {
          // Jika respons tidak sesuai yang diharapkan, lempar error
          throw new Error('Invalid session response data');
      }
    } catch (error) {
      // Lebih spesifik tentang error Axios
      if (axios.isAxiosError(error)) {
        console.error("Axios error in getSession:", error.response?.data || error.message);
        throw new Error(`Session request failed: ${error.response?.data?.message || error.message}`);
      } else {
        throw new Error(`Session request failed: ${error.message}`);
      }
    }
  }

  async sendPing(accountInfo, token, userAgent, proxy) {
    await this.initializeAxiosWrapper(); // Ini penting jika ping dipanggil tanpa connect

    const uid = accountInfo?.uid; // Pastikan uid ada
    if (!uid) {
        throw new Error("UID is missing for ping request.");
    }

    const pingData = {
      id: uid,
      browser_id: this.browserId, // Gunakan browserId dari instance Bot
      timestamp: Math.floor(Date.now() / 1000),
      version: '2.4.0', // Pastikan versi ini konsisten dengan versi yang diharapkan server
    };

    try {
      const requestConfig = { // Ganti 'config' menjadi 'requestConfig'
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
      };

      if (proxy) {
        requestConfig.proxy = this.buildProxyConfig(proxy);
      }

      // Mengubah axios.get menjadi axios.post karena endpoint ping biasanya menerima POST
      // dan Anda mengirim `pingData` sebagai body.
      // Pastikan pingURL diatur dengan benar di objek config
      // const response = await axios.post(this.config.pingURL, pingData, config);
      const response = await this.axiosInstance.post(this.config.pingURL, pingData, requestConfig); // Gunakan this.axiosInstance

      // Periksa respons dari ping
      if (response.data && response.data.code === 0) {
        console.log(`📡 ${'Ping sent'.cyan} for UID: ${uid} (IP Score: ${response.data.data?.ip_score || 'N/A'})`);
        this.logger.info('Ping sent', {
          uid,
          browserId: this.browserId,
          ip: proxy ? proxy.host : 'direct',
          response: response.data // Log respons penuh untuk debugging
        });
      } else {
        // Jika kode respons bukan 0, anggap sebagai error dari server
        throw new Error(`Ping API returned error code: ${response.data.code || 'unknown'} - ${response.data.message || 'No message'}`);
      }

    } catch (error) {
      // Lebih spesifik tentang error Axios
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        console.error(`Axios error in sendPing for UID ${uid}: Status ${status}, Message: ${message}`);
        throw new Error(`Ping failed (HTTP ${status || 'unknown'}): ${message}`);
      } else {
        throw new Error(`Ping failed: ${error.message}`);
      }
    }
  }

  buildProxyConfig(proxy) {
    return proxy && proxy.host
      ? {
          host: proxy.host,
          port: parseInt(proxy.port),
          auth:
            proxy.username && proxy.password
              ? { username: proxy.username, password: proxy.password }
              : undefined,
        }
      : undefined;
  }
}

module.exports = Bot;