// The ECHO concept space.
//
// A shared, human-readable semantic space that every content item and every
// user request is projected into, regardless of media type. Because a film, a
// song and a book land in the SAME space, preferences learned from one
// category transfer to the others. This is ECHO's cross-media layer, and it
// runs deterministically without any AI provider.
//
// Term syntax:
//   "philosoph"   single token, prefix-matched when >= 5 chars (philosophy, philosophical, ...)
//   "=war"        exact token match only (avoids "warm", "ward")
//   "black hole"  phrase match on word boundaries
//   "term:0.5"    custom weight (default 1)

export type ConceptGroup = 'theme' | 'mood' | 'quality';

export interface ConceptDef {
  id: string;
  label: string;
  group: ConceptGroup;
  terms: string[];
  /** Adjacent concepts, used for adventurous exploration and query expansion. */
  related: string[];
  /** Search terms to use when retrieving content for this concept, per category. */
  search?: Partial<Record<'youtube' | 'music' | 'screen' | 'books' | 'podcasts', string>>;
}

export const CONCEPTS: ConceptDef[] = [
  // ───────────────────────────── Themes ─────────────────────────────
  {
    id: 'existential', label: 'Existential', group: 'theme',
    terms: ['existential', 'existentialism', 'meaning of life', 'mortality', 'absurd', 'absurdism', 'camus', 'sartre', 'kierkegaard', 'nihilis', 'human condition', 'purpose', 'the void', 'finitude'],
    related: ['philosophy', 'cosmic', 'solitude', 'time-memory', 'spiritual'],
    search: { books: 'existentialism', screen: 'existentialism', music: 'existential', youtube: 'existentialism video essay', podcasts: 'meaning of life philosophy' },
  },
  {
    id: 'cosmic', label: 'Cosmic & space', group: 'theme',
    terms: ['=space', 'cosmos', 'cosmic', 'universe', 'galax', 'astronaut', 'astronom', 'planet', 'black hole', 'interstellar', 'nebula', '=nasa', 'orbit', 'stars', 'starlight', 'celestial', 'astrophysic', 'spacecraft', 'outer space', 'wormhole'],
    related: ['science', 'existential', 'awe', 'sci-fi'],
    search: { books: 'cosmology', screen: 'space', music: 'cosmic ambient', youtube: 'universe documentary', podcasts: 'astronomy' },
  },
  {
    id: 'sci-fi', label: 'Science fiction', group: 'theme',
    terms: ['science fiction', 'sci-fi', 'scifi', 'sf', 'cyberpunk', 'futuris', 'time travel', 'alien', 'robot', 'android', 'space opera', 'speculative fiction'],
    related: ['cosmic', 'technology', 'dystopia', 'existential'],
    search: { books: 'science fiction', screen: 'science fiction', music: 'synthwave', youtube: 'science fiction short film', podcasts: 'science fiction audio drama' },
  },
  {
    id: 'philosophy', label: 'Philosophy', group: 'theme',
    terms: ['philosoph', 'ethics', 'metaphysic', 'epistemolog', 'stoic', 'stoicism', 'nietzsche', 'plato', 'aristotle', 'socrat', 'consciousness', 'free will', 'moral', 'wisdom', 'thinker'],
    related: ['existential', 'psychology', 'spiritual', 'history'],
    search: { books: 'philosophy', screen: 'philosophy', youtube: 'philosophy lecture', podcasts: 'philosophy', music: 'contemplative' },
  },
  {
    id: 'science', label: 'Science', group: 'theme',
    terms: ['science', 'scientific', 'physics', 'quantum', 'biology', 'chemistry', 'evolution', 'neuroscien', 'mathemat', 'experiment', 'research', 'discovery', 'relativity', 'genetic'],
    related: ['cosmic', 'technology', 'nature', 'history'],
    search: { books: 'popular science', screen: 'science', youtube: 'science explained', podcasts: 'science', music: 'electronic' },
  },
  {
    id: 'technology', label: 'Technology & AI', group: 'theme',
    terms: ['technolog', 'artificial intelligence', '=ai', 'computer', 'internet', 'digital', 'software', 'silicon valley', 'algorithm', 'machine learning', 'startup', 'hacker', 'cyber'],
    related: ['science', 'sci-fi', 'society', 'business'],
    search: { books: 'technology', screen: 'artificial intelligence', youtube: 'technology documentary', podcasts: 'technology', music: 'electronic' },
  },
  {
    id: 'history', label: 'History', group: 'theme',
    terms: ['history', 'historical', 'histor', 'century', 'empire', 'medieval', 'renaissance', 'world war', 'revolution', 'dynasty', 'archive', 'biograph', 'era', 'victorian'],
    related: ['civilization', 'war', 'politics', 'society'],
    search: { books: 'history', screen: 'history', youtube: 'history documentary', podcasts: 'history', music: 'classical' },
  },
  {
    id: 'civilization', label: 'Ancient worlds & civilization', group: 'theme',
    terms: ['civilization', 'civilisation', 'ancient', 'archaeolog', 'mesopotamia', 'egypt', 'pharaoh', 'rome', 'roman', 'greece', 'greek', 'sumer', 'neolithic', 'prehistor', 'origins of civilization', 'origin of civilization', 'human origins', 'first cities', 'early humans', 'aztec', 'maya', 'bronze age', 'anthropolog'],
    related: ['history', 'myth', 'society', 'science'],
    search: { books: 'ancient civilization', screen: 'ancient', youtube: 'origins of civilization documentary', podcasts: 'ancient history', music: 'world music' },
  },
  {
    id: 'nature', label: 'Nature & wilderness', group: 'theme',
    terms: ['nature', 'wildlife', 'animal', 'ocean', 'forest', 'mountain', 'planet earth', 'ecolog', 'climate', 'environment', 'wilderness', 'landscape', 'river', 'desert', 'birds', 'natural world'],
    related: ['calm', 'science', 'survival', 'spiritual'],
    search: { books: 'nature writing', screen: 'nature', youtube: 'nature documentary', podcasts: 'nature', music: 'ambient nature' },
  },
  {
    id: 'love', label: 'Love & relationships', group: 'theme',
    terms: ['love', 'romance', 'romantic', 'relationship', 'heartbreak', 'lover', 'marriage', 'desire', 'intimacy', 'longing', 'crush', 'wedding'],
    related: ['romantic', 'melancholic', 'family', 'loss'],
    search: { books: 'love stories', screen: 'romance', youtube: 'love short film', podcasts: 'relationships', music: 'love songs' },
  },
  {
    id: 'loss', label: 'Loss & grief', group: 'theme',
    terms: ['grief', 'loss', 'mourning', 'death', 'dying', 'funeral', 'widow', 'bereave', 'goodbye', 'farewell', 'elegy', 'tragedy', 'tragic'],
    related: ['melancholic', 'love', 'existential', 'family'],
    search: { books: 'grief', screen: 'grief', music: 'sad songs', youtube: 'grief short film', podcasts: 'grief stories' },
  },
  {
    id: 'identity', label: 'Identity & self', group: 'theme',
    terms: ['identity', 'self-discovery', 'who am i', 'belonging', 'immigrant', 'diaspora', 'gender', 'self', 'authentic', 'outsider', 'alienation'],
    related: ['coming-of-age', 'psychology', 'society', 'solitude'],
    search: { books: 'identity', screen: 'identity', youtube: 'identity documentary', podcasts: 'identity stories', music: 'indie' },
  },
  {
    id: 'coming-of-age', label: 'Coming of age', group: 'theme',
    terms: ['coming of age', 'coming-of-age', 'adolescen', 'teenage', 'youth', 'growing up', 'high school', 'childhood', 'first love', 'young adult'],
    related: ['identity', 'nostalgic', 'family', 'love'],
    search: { books: 'coming of age', screen: 'coming of age', music: 'indie pop', youtube: 'coming of age short film', podcasts: 'growing up stories' },
  },
  {
    id: 'family', label: 'Family', group: 'theme',
    terms: ['family', 'mother', 'father', 'parent', 'daughter', 'brother', 'sister', 'siblings', 'generations', 'household', 'childhood home'],
    related: ['love', 'loss', 'coming-of-age', 'cozy'],
    search: { books: 'family saga', screen: 'family drama', music: 'folk', youtube: 'family documentary', podcasts: 'family stories' },
  },
  {
    id: 'society', label: 'Society & justice', group: 'theme',
    terms: ['society', 'social', 'justice', 'inequality', 'class', 'poverty', 'race', 'racism', 'civil rights', 'protest', 'activism', 'injustice', 'community', 'culture', 'sociolog'],
    related: ['politics', 'history', 'identity', 'economics'],
    search: { books: 'social justice', screen: 'social issues', youtube: 'society documentary', podcasts: 'society and culture', music: 'protest songs' },
  },
  {
    id: 'politics', label: 'Power & politics', group: 'theme',
    terms: ['politic', 'government', 'power', 'election', 'democracy', 'dictator', 'regime', 'geopolitic', 'propaganda', 'corruption', 'president', 'conspiracy', 'espionage', '=spy'],
    related: ['society', 'history', 'war', 'tense'],
    search: { books: 'politics', screen: 'political thriller', youtube: 'geopolitics explained', podcasts: 'politics analysis', music: 'protest songs' },
  },
  {
    id: 'war', label: 'War & conflict', group: 'theme',
    terms: ['=war', 'wars', 'warfare', 'battle', 'soldier', 'military', 'combat', 'army', 'invasion', 'world war', 'conflict', 'holocaust', 'vietnam', 'veteran'],
    related: ['history', 'politics', 'loss', 'survival'],
    search: { books: 'war', screen: 'war', youtube: 'war documentary', podcasts: 'military history', music: 'epic orchestral' },
  },
  {
    id: 'economics', label: 'Economics & business', group: 'theme',
    terms: ['econom', 'business', 'finance', 'money', 'market', 'capitalism', 'entrepreneur', 'company', 'invest', 'wealth', 'startup', 'trade', 'wall street'],
    related: ['technology', 'politics', 'society'],
    search: { books: 'economics', screen: 'business', youtube: 'economics explained', podcasts: 'business', music: 'focus' },
  },
  {
    id: 'psychology', label: 'Mind & psychology', group: 'theme',
    terms: ['psycholog', 'mind', 'mental', 'brain', 'memory', 'dream', 'unconscious', 'behavior', 'behaviour', 'emotion', 'trauma', 'therapy', 'cognitive', 'perception', 'madness'],
    related: ['philosophy', 'identity', 'science', 'mystery'],
    search: { books: 'psychology', screen: 'psychological', youtube: 'psychology explained', podcasts: 'psychology', music: 'introspective' },
  },
  {
    id: 'spiritual', label: 'Spirituality & transcendence', group: 'theme',
    terms: ['spiritual', 'religio', 'sacred', 'meditat', 'buddhis', 'zen', '=god', 'faith', 'mystic', 'transcend', 'soul', 'divine', 'enlightenment', 'prayer', 'monk'],
    related: ['philosophy', 'calm', 'existential', 'nature'],
    search: { books: 'spirituality', screen: 'spiritual', youtube: 'meditation', podcasts: 'spirituality', music: 'meditative ambient' },
  },
  {
    id: 'mystery', label: 'Mystery & crime', group: 'theme',
    terms: ['mystery', 'mysteries', 'crime', 'detective', 'murder', 'investigat', 'thriller', 'heist', 'noir', 'whodunit', 'police', 'serial killer', 'true crime', 'cold case', 'suspense'],
    related: ['tense', 'dark', 'psychology', 'politics'],
    search: { books: 'mystery', screen: 'crime', youtube: 'unsolved mystery', podcasts: 'true crime', music: 'noir jazz' },
  },
  {
    id: 'horror', label: 'Horror & dread', group: 'theme',
    terms: ['horror', 'terror', 'haunted', 'ghost', 'monster', 'demon', 'supernatural', 'creepy', 'slasher', 'zombie', 'vampire', 'occult', 'nightmare'],
    related: ['eerie', 'dark', 'tense', 'mystery'],
    search: { books: 'horror', screen: 'horror', youtube: 'horror short film', podcasts: 'horror stories', music: 'dark ambient' },
  },
  {
    id: 'myth', label: 'Fantasy & myth', group: 'theme',
    terms: ['fantasy', 'myth', 'mythology', 'legend', 'magic', 'wizard', 'dragon', 'fairy tale', 'folklore', 'quest', 'epic fantasy', 'sword'],
    related: ['adventure', 'civilization', 'dreamy', 'awe'],
    search: { books: 'fantasy', screen: 'fantasy', youtube: 'mythology explained', podcasts: 'mythology', music: 'fantasy soundtrack' },
  },
  {
    id: 'dystopia', label: 'Dystopia', group: 'theme',
    terms: ['dystopi', 'totalitarian', 'apocalyp', 'post-apocalyptic', 'surveillance', 'collapse', 'big brother', 'oppression', 'end of the world'],
    related: ['sci-fi', 'politics', 'dark', 'survival'],
    search: { books: 'dystopian fiction', screen: 'dystopia', music: 'dark synth', youtube: 'dystopia video essay', podcasts: 'dystopian fiction' },
  },
  {
    id: 'adventure', label: 'Adventure & journeys', group: 'theme',
    terms: ['adventure', 'journey', 'expedition', 'explor', 'voyage', 'road trip', 'odyssey', 'treasure', 'discover', 'quest', 'travel'],
    related: ['travel', 'myth', 'survival', 'energetic'],
    search: { books: 'adventure', screen: 'adventure', youtube: 'expedition documentary', podcasts: 'adventure stories', music: 'adventure soundtrack' },
  },
  {
    id: 'travel', label: 'Travel & places', group: 'theme',
    terms: ['travel', 'city', 'cities', 'country', 'culture', 'journey', 'abroad', 'backpack', 'tokyo', 'paris', 'trip', 'destination', 'cuisine'],
    related: ['adventure', 'food', 'society', 'nature'],
    search: { books: 'travel writing', screen: 'travel', youtube: 'travel documentary', podcasts: 'travel', music: 'world music' },
  },
  {
    id: 'survival', label: 'Survival & endurance', group: 'theme',
    terms: ['survival', 'survive', 'stranded', 'endurance', 'resilience', 'struggle', 'overcome', 'escape', 'against all odds', 'castaway'],
    related: ['adventure', 'nature', 'war', 'uplifting'],
    search: { books: 'survival', screen: 'survival', youtube: 'survival story', podcasts: 'survival stories', music: 'anthemic' },
  },
  {
    id: 'time-memory', label: 'Time & memory', group: 'theme',
    terms: ['time', 'memory', 'memories', 'remember', 'past', 'forgotten', 'nostalgia', 'timeless', 'eternity', 'generations', 'aging', 'old age', 'remembrance'],
    related: ['nostalgic', 'existential', 'loss', 'psychology'],
    search: { books: 'memory', screen: 'memory', music: 'nostalgic', youtube: 'time explained', podcasts: 'memory' },
  },
  {
    id: 'solitude', label: 'Solitude & introspection', group: 'theme',
    terms: ['solitude', 'alone', 'lonely', 'loneliness', 'isolation', 'introspect', 'quiet', 'hermit', 'reflection', 'inner life', 'night'],
    related: ['contemplative', 'melancholic', 'existential', 'calm'],
    search: { books: 'solitude', screen: 'loneliness', music: 'introspective', youtube: 'solitude', podcasts: 'introspection' },
  },
  {
    id: 'art', label: 'Art & creativity', group: 'theme',
    terms: ['art', 'artist', 'painting', 'painter', 'design', 'architecture', 'creativ', 'creative process', 'museum', 'sculpture', 'photograph', 'film-making', 'filmmaking', 'craft', 'poetry', 'poet', 'writer'],
    related: ['music-culture', 'identity', 'philosophy', 'dreamy'],
    search: { books: 'art', screen: 'artist', youtube: 'art documentary', podcasts: 'creativity', music: 'experimental' },
  },
  {
    id: 'music-culture', label: 'Music culture', group: 'theme',
    terms: ['musician', 'band', 'album', 'concert', 'songwriter', 'record', 'composer', 'rock and roll', 'hip hop', 'jazz history', 'music industry', 'tour'],
    related: ['art', 'history', 'energetic'],
    search: { books: 'music biography', screen: 'music documentary', youtube: 'music documentary', podcasts: 'music history', music: 'classic albums' },
  },
  {
    id: 'humor', label: 'Humor & comedy', group: 'theme',
    terms: ['comedy', 'comedic', 'funny', 'humor', 'humour', 'satire', 'sitcom', 'parody', 'stand-up', 'hilarious', 'absurd humor', 'laugh', 'witty'],
    related: ['joyful', 'society', 'cozy'],
    search: { books: 'humor', screen: 'comedy', youtube: 'comedy sketch', podcasts: 'comedy', music: 'feel good' },
  },
  {
    id: 'food', label: 'Food & craft', group: 'theme',
    terms: ['food', 'cooking', 'chef', 'cuisine', 'recipe', 'restaurant', 'kitchen', 'baking', 'wine', 'coffee'],
    related: ['travel', 'cozy', 'art'],
    search: { books: 'cooking', screen: 'food', youtube: 'cooking', podcasts: 'food', music: 'jazz cafe' },
  },
  {
    id: 'sports', label: 'Sports & competition', group: 'theme',
    terms: ['sport', 'athlete', 'football', 'soccer', 'basketball', 'olympic', 'tennis', 'boxing', 'championship', 'climbing', 'marathon', 'competition', 'coach'],
    related: ['survival', 'energetic', 'uplifting'],
    search: { books: 'sports', screen: 'sports', youtube: 'sports documentary', podcasts: 'sports', music: 'workout' },
  },
  {
    id: 'health', label: 'Health & wellbeing', group: 'theme',
    terms: ['health', 'wellbeing', 'well-being', 'fitness', 'nutrition', 'sleep', 'longevity', 'habit', 'self-help', 'self help', 'productivity', 'mindful'],
    related: ['psychology', 'calm', 'science'],
    search: { books: 'self-help', screen: 'health', youtube: 'health science', podcasts: 'health', music: 'focus' },
  },

  // ───────────────────────────── Moods ─────────────────────────────
  {
    id: 'melancholic', label: 'Melancholic', group: 'mood',
    terms: ['melanchol', 'sad', 'sadness', 'sorrow', 'blue:0.3', 'bittersweet', 'wistful', 'heartbreak', 'tears', 'lament', 'gloomy', 'somber', 'sombre', 'mournful', 'difficult night'],
    related: ['nostalgic', 'contemplative', 'loss', 'dreamy'],
    search: { music: 'melancholic', screen: 'melancholy', books: 'melancholy', youtube: 'melancholic', podcasts: 'melancholy' },
  },
  {
    id: 'uplifting', label: 'Uplifting & hopeful', group: 'mood',
    terms: ['uplifting', 'hopeful', 'hope', 'inspiring', 'inspirational', 'optimis', 'heartwarming', 'triumph', 'redemption', 'sunrise', 'dawn', 'healing', 'feel-good', 'feel good', 'renewal', 'rebirth', 'light after'],
    related: ['joyful', 'awe', 'calm', 'survival'],
    search: { music: 'uplifting', screen: 'inspiring', books: 'hopeful', youtube: 'inspiring', podcasts: 'inspiring stories' },
  },
  {
    id: 'nostalgic', label: 'Nostalgic', group: 'mood',
    terms: ['nostalgi', 'retro', 'vintage', 'childhood', 'remember when', 'old days', 'throwback', 'reminisc', '80s', '90s', '70s', 'golden age'],
    related: ['melancholic', 'time-memory', 'cozy', 'dreamy'],
    search: { music: 'nostalgic', screen: 'nostalgic', books: 'nostalgia', youtube: 'nostalgia', podcasts: 'nostalgia' },
  },
  {
    id: 'calm', label: 'Calm & serene', group: 'mood',
    terms: ['calm', 'serene', 'peaceful', 'relax', 'gentle', 'soothing', 'tranquil', 'slow', 'quiet', 'ambient', 'lofi', 'lo-fi', 'chill', 'mellow', 'soft'],
    related: ['contemplative', 'cozy', 'dreamy', 'nature'],
    search: { music: 'calm ambient', screen: 'slow cinema', books: 'quiet novel', youtube: 'relaxing', podcasts: 'calm' },
  },
  {
    id: 'energetic', label: 'Energetic', group: 'mood',
    terms: ['energetic', 'energy', 'upbeat', 'fast', 'dance', 'party', 'workout', 'hype', 'adrenaline', 'action', 'driving', 'pump', 'banger', 'groove', 'intense'],
    related: ['joyful', 'intense', 'adventure', 'sports'],
    search: { music: 'upbeat', screen: 'action', books: 'fast-paced thriller', youtube: 'high energy', podcasts: 'energetic' },
  },
  {
    id: 'dark', label: 'Dark', group: 'mood',
    terms: ['dark', 'darkness', 'bleak', 'grim', 'brutal', 'violent', 'disturbing', 'sinister', 'noir', 'gritty', 'moral ambiguity'],
    related: ['tense', 'eerie', 'horror', 'dystopia'],
    search: { music: 'dark', screen: 'dark', books: 'dark fiction', youtube: 'dark documentary', podcasts: 'dark stories' },
  },
  {
    id: 'tense', label: 'Tense & suspenseful', group: 'mood',
    terms: ['tense', 'tension', 'suspense', 'thrilling', 'gripping', 'edge of your seat', 'nail-biting', 'paranoi', 'cat and mouse', 'race against time'],
    related: ['mystery', 'dark', 'energetic', 'politics'],
    search: { music: 'tense cinematic', screen: 'thriller', books: 'thriller', youtube: 'suspense', podcasts: 'thriller' },
  },
  {
    id: 'dreamy', label: 'Dreamy & atmospheric', group: 'mood',
    terms: ['dreamy', 'dreamlike', 'atmospher', 'ethereal', 'hypnotic', 'surreal', 'hazy', 'shoegaze', 'dream pop', 'immersive', 'otherworldly', 'lush', 'ambient'],
    related: ['calm', 'melancholic', 'awe', 'art'],
    search: { music: 'dream pop', screen: 'surreal', books: 'surreal fiction', youtube: 'atmospheric', podcasts: 'ambient storytelling' },
  },
  {
    id: 'joyful', label: 'Joyful & playful', group: 'mood',
    terms: ['joy', 'joyful', 'happy', 'happiness', 'playful', 'cheerful', 'fun', 'delight', 'whimsical', 'sunny', 'bright', 'celebrat', 'charming', 'lighthearted'],
    related: ['uplifting', 'humor', 'energetic', 'cozy'],
    search: { music: 'happy', screen: 'feel good', books: 'feel good', youtube: 'feel good', podcasts: 'feel good' },
  },
  {
    id: 'romantic', label: 'Romantic', group: 'mood',
    terms: ['romantic', 'tender', 'sensual', 'passion', 'swoon', 'intimate', 'sweet', 'yearning'],
    related: ['love', 'dreamy', 'melancholic'],
    search: { music: 'romantic', screen: 'romantic', books: 'romance', youtube: 'romantic', podcasts: 'love stories' },
  },
  {
    id: 'contemplative', label: 'Contemplative', group: 'mood',
    terms: ['contemplat', 'reflective', 'meditative', 'thoughtful', 'introspective', 'pensive', 'slow-burn', 'slow burn', 'quiet', 'poetic', 'profound', 'philosophical'],
    related: ['philosophy', 'solitude', 'calm', 'existential'],
    search: { music: 'contemplative', screen: 'contemplative', books: 'reflective essays', youtube: 'video essay', podcasts: 'long-form conversation' },
  },
  {
    id: 'awe', label: 'Awe & wonder', group: 'mood',
    terms: ['awe', 'wonder', 'awe-inspiring', 'breathtaking', 'majestic', 'epic', 'sublime', 'grand', 'vast', 'monumental', 'spectacular', 'mind-blowing', 'beautiful'],
    related: ['cosmic', 'nature', 'uplifting', 'myth'],
    search: { music: 'epic cinematic', screen: 'epic', books: 'awe', youtube: 'awe inspiring', podcasts: 'wonder' },
  },
  {
    id: 'intense', label: 'Intense & raw', group: 'mood',
    terms: ['intense', 'raw', 'angry', 'anger', 'rage', 'aggressive', 'heavy', 'visceral', 'powerful', 'furious', 'metal', 'punk', 'screaming'],
    related: ['energetic', 'dark', 'tense'],
    search: { music: 'intense', screen: 'intense drama', books: 'intense', youtube: 'intense', podcasts: 'intense stories' },
  },
  {
    id: 'cozy', label: 'Cozy & comforting', group: 'mood',
    terms: ['cozy', 'cosy', 'comfort', 'comforting', 'warm', 'warmth', 'wholesome', 'homey', 'rainy day', 'fireplace', 'snug', 'gentle humor'],
    related: ['calm', 'joyful', 'nostalgic', 'family'],
    search: { music: 'cozy acoustic', screen: 'comfort', books: 'cozy', youtube: 'cozy', podcasts: 'comforting' },
  },
  {
    id: 'eerie', label: 'Eerie & uncanny', group: 'mood',
    terms: ['eerie', 'uncanny', 'unsettling', 'haunting', 'ominous', 'creepy', 'strange', 'weird', 'liminal', 'mysterious', 'otherworldly'],
    related: ['horror', 'dark', 'dreamy', 'mystery'],
    search: { music: 'haunting', screen: 'eerie', books: 'weird fiction', youtube: 'eerie', podcasts: 'unexplained' },
  },

  // ───────────────────────────── Qualities ─────────────────────────────
  {
    id: 'cerebral', label: 'Cerebral & complex', group: 'quality',
    terms: ['complex', 'cerebral', 'intellectual', 'challenging', 'dense', 'layered', 'thought-provoking', 'mind-bending', 'nonlinear', 'rigorous', 'in-depth', 'in depth', 'deep dive', 'lecture', 'academic', 'serious'],
    related: ['philosophy', 'science', 'contemplative'],
    search: { youtube: 'deep dive', podcasts: 'in-depth interview', books: 'classic', screen: 'arthouse', music: 'progressive' },
  },
  {
    id: 'accessible', label: 'Easy-going & accessible', group: 'quality',
    terms: ['easy', 'light', 'lighthearted', 'casual', 'simple', 'beginner', 'introduction', 'for beginners', 'easy listening', 'popcorn', 'background'],
    related: ['cozy', 'joyful', 'humor'],
    search: { youtube: 'explained simply', podcasts: 'casual conversation', books: 'introduction', screen: 'feel good', music: 'easy listening' },
  },
  {
    id: 'documentary', label: 'Documentary & nonfiction', group: 'quality',
    terms: ['documentary', 'documentaries', 'docuseries', 'nonfiction', 'non-fiction', 'true story', 'based on a true story', 'real story', 'investigative', 'reportage', 'biography', 'memoir'],
    related: ['history', 'science', 'society'],
    search: { youtube: 'documentary', screen: 'documentary', books: 'nonfiction', podcasts: 'documentary', music: 'soundtrack' },
  },
];

export const CONCEPT_IDS = CONCEPTS.map((c) => c.id);
export const CONCEPT_BY_ID: Record<string, ConceptDef> = Object.fromEntries(CONCEPTS.map((c) => [c.id, c]));
export const MOOD_IDS = CONCEPTS.filter((c) => c.group === 'mood').map((c) => c.id);
export const THEME_IDS = CONCEPTS.filter((c) => c.group === 'theme').map((c) => c.id);

/** Mood chips shown in the Discover UI (subset of mood concepts). */
export const MOOD_CHIPS = ['melancholic', 'uplifting', 'calm', 'energetic', 'nostalgic', 'dreamy', 'contemplative', 'awe', 'dark', 'cozy', 'joyful', 'tense'];

export function conceptLabel(id: string): string {
  return CONCEPT_BY_ID[id]?.label ?? id;
}
