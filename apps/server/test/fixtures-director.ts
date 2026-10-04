// Canned director output for tests: what a good model returns for "a 25 second animated mystery short about a delivery rider".
export const DIRECTOR_OUTLINE = {
  title: "The Last Delivery",
  logline: "A delivery rider's last order of the night is addressed to himself and leads to a building that has been waiting for him.",
  characters: [
    { id: "kai", name: "Kai", role: "a tired but curious delivery rider", appearance: "young man with short dark hair and a worried face", clothing: "orange jacket with black stripes and a delivery backpack" },
    { id: "stranger", name: "The Stranger", role: "a calm man who knows too much", appearance: "tall man with sharp features and slicked brown hair", clothing: "long mustard-yellow coat over a black shirt" },
  ],
  locations: [
    { id: "alley", name: "Sundial Alley", look: "narrow old city alley at night, wet cobblestones, brick walls", lighting: "warm lantern light against cold blue haze" },
    { id: "lobby", name: "Abandoned lobby", look: "dim abandoned lobby with cracked marble floor and one old elevator", lighting: "a single flickering ceiling light and warm elevator glow" },
  ],
};

const shot = (o: Record<string, unknown>) => ({ emotion: "neutral", character: "", ...o });
export const DIRECTOR_SHOTS = {
  shots: [
    shot({ beat: "hook", shotType: "extreme-close-up", location: "alley", character: "", emotion: "curious", action: "A phone buzzes in the dark with a new order for Kai.", line: { speaker: "kai", text: "The last order of the night. The name on it was mine." }, onScreenText: "DELIVER TO: KAI" }),
    shot({ beat: "setup", shotType: "establishing", location: "alley", character: "kai", emotion: "uneasy", action: "A lone rider stands small at the end of the alley.", line: { speaker: "kai", text: "Sundial Court. Nobody has lived there for years." } }),
    shot({ beat: "curiosity", shotType: "low-angle", location: "alley", character: "", emotion: "eerie", action: "The dark tower looms, one window glows." }),
    shot({ beat: "curiosity", shotType: "medium-close", location: "alley", character: "kai", emotion: "uneasy", action: "Kai looks up, hand tight on the handlebar.", line: { speaker: "kai", text: "Hello? Delivery for me?" } }),
    shot({ beat: "conflict", shotType: "wide", location: "lobby", character: "", emotion: "eerie", action: "The old elevator doors slide open by themselves." }),
    shot({ beat: "conflict", shotType: "medium", location: "lobby", character: "stranger", emotion: "eerie", action: "A man in a yellow coat waits inside the elevator.", line: { speaker: "stranger", text: "You are late, Kai. Again." } }),
    shot({ beat: "escalation", shotType: "close-up", location: "alley", character: "kai", emotion: "shock", action: "Kai freezes, eyes wide.", line: { speaker: "kai", text: "Again?!" } }),
    shot({ beat: "escalation", shotType: "extreme-close-up", location: "alley", character: "", emotion: "tense", action: "The phone glitches and shows a message.", line: { speaker: "stranger", text: "You always come back." }, onScreenText: "DELIVERED EVERY NIGHT" }),
    shot({ beat: "payoff", shotType: "extreme-close-up", location: "lobby", character: "kai", emotion: "eerie", action: "Kai's double smiles calmly.", line: { speaker: "stranger", text: "Welcome home." } }),
    shot({ beat: "payoff", shotType: "wide", location: "alley", character: "", emotion: "calm", action: "The building goes dark and the title appears." }),
  ],
};
