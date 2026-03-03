module.exports = {
  apps: [
    {
      name: "claude-discord",
      script: "dist/index.js",
      cwd: "/Volumes/T7/projects/claude-with-discord",
      instances: 1,
      exec_mode: "cluster",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      wait_ready: true,
      listen_timeout: 10000,
      // 재시작 관련 설정 - 무한 자동 재시작
      min_uptime: "5s",            // 5초 이상 실행되어야 정상 시작으로 간주
      max_restarts: 999999,        // 사실상 무한 자동 재시작
      restart_delay: 5000,         // 재시작 사이 5초 대기
      exp_backoff_restart_delay: 100, // 연속 실패 시 지수적으로 대기 시간 증가 (100ms -> 200ms -> 400ms ...)
      kill_timeout: 10000,         // 종료 시 10초 대기 후 강제 종료
      // 크래시 후에도 계속 재시작
      autorestart: true,           // 프로세스 종료 시 자동 재시작
      stop_exit_codes: [],         // 모든 exit code에서 재시작 (빈 배열 = 항상 재시작)
      env: {
        NODE_ENV: "production",
        PATH: "/Users/boxfox/.nvm/versions/node/v20.10.0/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
    },
  ],
  deploy: {
    production: {
      "pre-deploy-local": "npm run build || exit 1",
    },
  },
};
