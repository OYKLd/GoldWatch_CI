import { config } from './config.js';
import { createApp, startMaintenance } from './app.js';

const app = createApp();
startMaintenance();
app.listen(config.port, '0.0.0.0', () => {
  console.log(`GoldWatch CI API    http://localhost:${config.port}/api/health`);
  console.log(`Dashboard autorités http://localhost:${config.port}/dashboard/`);
  console.log('Clés de démonstration : backend/data/credentials.json');
});
