module.exports = {
  apps: [
    {
      name: 'pricebot',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      max_memory_restart: '500M',
      time: true,
    },
  ],
};
