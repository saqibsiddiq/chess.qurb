use regex::Regex;
use std::sync::LazyLock;

use crate::slm::MoveFacts;

static PAWNS_CLAUSE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i),?\s*giving up (?:only )?about [\d.]+ pawns?").unwrap()
});
static COLLAPSE_SPACE_COMMA_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+,").unwrap());
static COLLAPSE_COMMA_AND_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r",\s*and\b").unwrap());

fn correct_outcome_clause(facts: &MoveFacts) -> String {
    if let Some(after_mate) = facts.eval_after_mate {
        if after_mate == 0 {
            return " and delivers checkmate".to_string();
        }
        let color = if after_mate > 0 { "White" } else { "Black" };
        return format!(
            ", which allows a forced mate in {} for {color}",
            after_mate.abs()
        );
    }
    if let Some(before_mate) = facts.eval_before_mate {
        return format!(", which misses a forced mate in {}", before_mate.abs());
    }
    if let Some(loss_cp) = facts.loss_cp {
        let pawns = (loss_cp / 100.0 * 100.0).round() / 100.0;
        return format!(", giving up about {pawns} pawns");
    }
    String::new()
}

pub fn correct_explanation(facts: &MoveFacts, generated: &str) -> (String, bool) {
    if !PAWNS_CLAUSE_RE.is_match(generated) {
        return (generated.to_string(), false);
    }

    let correct_clause = correct_outcome_clause(facts);
    let corrected = PAWNS_CLAUSE_RE.replace(generated, correct_clause.as_str());
    let corrected = COLLAPSE_SPACE_COMMA_RE.replace_all(&corrected, ",");
    let corrected = COLLAPSE_COMMA_AND_RE.replace_all(&corrected, " and");
    let corrected = corrected.into_owned();
    let was_corrected = corrected != generated;
    (corrected, was_corrected)
}
