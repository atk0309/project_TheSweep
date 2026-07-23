// Route registration. Grows across build steps (auth → state/draw → admin).
import { registerAuthRoutes } from './auth.js';
import { registerApiRoutes } from './api.js';
import { registerAdminRoutes } from './admin.js';

export function registerRoutes(app) {
  registerAuthRoutes(app);
  registerApiRoutes(app);
  registerAdminRoutes(app);
}
