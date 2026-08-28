import { serve } from 'hostproto-dap-core';
import { debugpyBinding } from './binding.js';
serve(debugpyBinding());
