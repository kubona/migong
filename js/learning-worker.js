import { trainForest } from './learning-model.js';
self.onmessage = e => {
  try { self.postMessage({ model: trainForest(e.data.rows, e.data.seed) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
