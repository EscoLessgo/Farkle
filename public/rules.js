export const SCORING_RULES = {
    TRIPLE_1: 1000,
    TRIPLE_2: 200,
    TRIPLE_3: 300,
    TRIPLE_4: 400,
    TRIPLE_5: 500,
    TRIPLE_6: 600,
    SINGLE_1: 100,
    SINGLE_5: 50
};

export function calculateScore(dice) {
    if (!dice || dice.length === 0) return 0;

    const counts = {};
    for (const die of dice) {
        counts[die] = (counts[die] || 0) + 1;
    }

    let score = 0;

    for (let face = 1; face <= 6; face++) {
        const count = counts[face] || 0;

        let tripleValue = 0;
        if (face === 1) tripleValue = SCORING_RULES.TRIPLE_1;
        else if (face === 2) tripleValue = SCORING_RULES.TRIPLE_2;
        else if (face === 3) tripleValue = SCORING_RULES.TRIPLE_3;
        else if (face === 4) tripleValue = SCORING_RULES.TRIPLE_4;
        else if (face === 5) tripleValue = SCORING_RULES.TRIPLE_5;
        else if (face === 6) tripleValue = SCORING_RULES.TRIPLE_6;

        if (count >= 3) {
            let multiplier = 0;
            if (count === 3) multiplier = 1;
            else if (count === 4) multiplier = 2;
            else if (count === 5) multiplier = 3;
            else if (count === 6) multiplier = 4;

            score += tripleValue * multiplier;
        } else {
            // Count leftovers only if they are 1 or 5
            if (face === 1) score += count * SCORING_RULES.SINGLE_1;
            if (face === 5) score += count * SCORING_RULES.SINGLE_5;
        }
    }

    return score;
}

export function isScoringSelection(dice) {
    // A selection is valid if EVERY die in it contributes to the score.
    // This prevents holding non-scoring junk dice.
    // How to check?
    // Calculate total score of set.
    // Remove one die. Calculate score.
    // If score dropped, that die was contributing.
    // Do this for all? Efficient enough for 6 dice.

    // Actually simpler:
    // If a face has count < 3 and is not 1 or 5, it's non-scoring.
    // EXCEPTION: A proper implementations might allow 4,4,4,4 where removing one 4 changes it from 4x to 3x (score changes).
    // But removing a 2 from 2,2,2 (200) -> 2,2 (0) also changes score.
    // So non-scoring dice are faces like 2,3,4,6 appearing < 3 times.

    const counts = {};
    for (const die of dice) {
        counts[die] = (counts[die] || 0) + 1;
    }

    for (let face = 1; face <= 6; face++) {
        const count = counts[face] || 0;
        if (count > 0) {
            if (count < 3 && face !== 1 && face !== 5) {
                return false; // Found a naked 2, 3, 4, or 6
            }
        }
    }
    return true;
}

export function hasPossibleMoves(dice) {
    // Used to check for Farkle on a roll
    // If the roll contains ANY subset that scores, it's not a Farkle.
    // Just need to check if there are any 1s, 5s, or any triples.

    const counts = {};
    for (const die of dice) {
        counts[die] = (counts[die] || 0) + 1;
    }

    if (counts[1] > 0 || counts[5] > 0) return true;
    for (let face = 2; face <= 6; face++) {
        if ((counts[face] || 0) >= 3) return true;
    }

    return false;
}
