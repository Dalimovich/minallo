// Sidebar sprite-icon binder. Re-exports from the central icons config so
// portal-ui can keep its existing import path without owning a second copy
// of the SVG markup.

export { applySidebarIcons as initSidebarIcons } from '../config/icons.js';
