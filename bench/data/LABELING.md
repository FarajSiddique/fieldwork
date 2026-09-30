# Labeling guide for the written set

Every ticket in `written.jsonl` is labeled by these rules. A ticket stays `"status": "draft"` until the owner has checked all its labels against this guide, and only `final` tickets can be benchmarked. When a rule and your instinct disagree, follow the rule and, if the rule is wrong, change the rule and relabel every ticket.

The tickets are synthetic: written by hand for this benchmark, in the domain of an online shop.

## Rule 1: `intent`, the primary request

Choose one of the 27 intents in `bench/src/intents.ts`, using their descriptions as the definitions.

A ticket with several requests (tagged `mixed_intents`) is labeled with the **first request the customer makes**, unless they mark another as the main one ("most importantly", "the real problem is", "mainly"). A statement of what went wrong counts as a request when it is a claim: "my package was stolen" is `complaint`.

## Rule 2: `complexity`, the Score's three levels

| Level | Text jev sees | Use when |
|---|---|---|
| 0 | Simple lookup or standard procedure | One standard step, or an answer straight from policy: a tracking link, a fee question, cancelling an unshipped order, changing an address before shipping |
| 1 | Requires some judgment or multi-step process | Specifics must be checked or several steps taken, within policy: stalled tracking, a reset email that never arrives, a wrong item to refund, closing an account, **any ticket with two separate requests** |
| 2 | Unusual situation, edge case, or escalation needed | Outside standard procedure (list below) |

Complexity 2 is for:

- money in dispute: double charges, a charge with no order, a disputed fee, a refund overdue past policy;
- a fix or refund that was promised and has not happened;
- damage, loss or theft claims;
- complaints about staff or conduct;
- legal, privacy or security matters (data deletion requests under GDPR, account takeover);
- health or safety at risk;
- **any ticket containing instructions aimed at the support system** (tagged `injected_instructions`). These are always complexity 2.

## Rule 3: `needsEscalation`

A ticket needs a person when **any** of these holds:

1. its complexity is 2 (the validator enforces this);
2. the customer asks for a person;
3. the customer says an earlier **contact with support** about this same problem went unresolved.

Otherwise it does not. A customer who unsubscribed twice through a link has not contacted support. A customer who "asked twice by email and nobody replied" has.

## Rule 4: `isRepeat`

`true` when the customer says this problem happened before: on an earlier order, on an earlier day, or in an earlier contact. Retrying within the same attempt ("I tried three times in the last ten minutes") does not count. `isRepeat` is about the problem's history. It does not by itself mean escalation (rule 3).

## Rule 5: `orderNumber`

The order number the customer is asking about, **copied exactly as written**, including a leading `#` if the ticket has one. `null` when the customer gives none. Invoice, receipt, return, case, transaction, member, PO and tracking numbers are not order numbers. When a ticket names two orders, it is the one the request is about.

The validator requires the label to be a number the candidate regex (`#?\d{5,}`) finds. A ticket with an order number also needs another such number, so the pick has a real distractor.

## Rule 6: `hardCases`

Tag what the ticket tests, not everything it contains:

- `mixed_intents`: two or more separate requests;
- `relative_dates`: the right answer depends on a date given relative to today ("the Friday before last", "the day after tomorrow");
- `injected_instructions`: an embedded instruction aimed at the support system, quoted from `TrustAIRLab/in-the-wild-jailbreak-prompts`. The ticket names the quoted row in `injectionSource` (see `NOTICE.md`), and its other labels follow the customer's real request, not the injection.
