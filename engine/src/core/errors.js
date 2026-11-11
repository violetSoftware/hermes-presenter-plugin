export class DeckError extends Error { constructor(message,cause){ super(message,{cause}); this.name='DeckError'; } }
