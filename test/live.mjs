// Prints the dashboard model for a journal: node test/live.mjs owner/repo
// GITHUB_TOKEN raises the rate limit; without it the run uses the anonymous 60 per hour.
import { loadJournal, loadPaper, waitingOnEditors, setToken, rate } from '../public/data.js';

setToken(process.env.GITHUB_TOKEN);
const j = await loadJournal(process.argv[2]);
const papers = await Promise.all(j.papers.map((p) => loadPaper(p, j)));
const { meta, ...journal } = j;
console.log(JSON.stringify({ journal: { ...journal, papers: undefined }, papers, waiting: waitingOnEditors(j, papers), rate }, null, 2));
