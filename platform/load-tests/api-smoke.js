import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    api_ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 200,
      stages: [
        { target: 50, duration: '30s' },
        { target: 300, duration: '60s' },
        { target: 1000, duration: '30s' },
        { target: 50, duration: '30s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.005'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
  },
};

const baseUrl = __ENV.BASE_URL || 'http://127.0.0.1:3000';

export default function () {
  const response = http.get(baseUrl + '/api/health/live', {
    headers: { 'x-load-test': 'synthetic' },
  });
  check(response, { 'health endpoint is 200': (value) => value.status === 200 });
  sleep(0.1);
}

