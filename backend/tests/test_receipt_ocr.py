"""Rebuilding printed rows from OCR boxes (app/services/receipt_ai/ocr.py), with box positions taken from real photos."""

from app.services.receipt_ai import ocr


def box(x0, x1, y0, y1, h):
    return [[x0, y0], [x1, y1], [x1, y1 + h], [x0, y0 + h]]


def rows(pieces):
    text, _ = ocr.layout([box(*p[1:]) for p in pieces], [p[0] for p in pieces], [0.99] * len(pieces))
    return [" ".join(line.split()) for line in text.splitlines()]


def test_level_rows_whose_boxes_lean_keep_each_price_on_its_line():
    # Flat receipt, but the text boxes lean +0.03: extending that slant put prices a row off
    pieces = [
        ("€3.40", 743, 817, 346, 346, 32), ("1 Barilla Arrabbiata Pasta Sauce 400g", 269, 735, 341, 349, 44),
        ("-€1.90", 735, 817, 372, 370, 32), ("Cc Any 2 For €3", 307, 502, 373, 378, 34),
        ("€3.40", 744, 818, 397, 397, 32), ("1 Barilla Basilico Pasta Sauce 400g", 268, 710, 390, 399, 44),
        ("-€1.90", 735, 818, 422, 420, 32), ("Cc Any 2 For €3", 304, 503, 419, 426, 36),
        ("€2.50", 744, 818, 447, 447, 32), ("1 Barilla Tortiglioni 500g", 266, 599, 439, 447, 43),
        ("-€1.00", 736, 818, 472, 472, 32), ("Cc Any 2 For €3", 304, 502, 468, 474, 36),
        ("1 Barilla Fusilli 500g", 266, 549, 488, 497, 40), ("€2.50", 742, 817, 496, 494, 36),
        ("-€1.00", 734, 818, 521, 519, 35), ("Cc Any 2 For €3", 302, 502, 516, 523, 37),
    ]
    assert rows(pieces) == [
        "1 Barilla Arrabbiata Pasta Sauce 400g €3.40", "Cc Any 2 For €3 -€1.90",
        "1 Barilla Basilico Pasta Sauce 400g €3.40", "Cc Any 2 For €3 -€1.90",
        "1 Barilla Tortiglioni 500g €2.50", "Cc Any 2 For €3 -€1.00",
        "1 Barilla Fusilli 500g €2.50", "Cc Any 2 For €3 -€1.00",
    ]


def test_curled_paper_prices_follow_their_rows_slant():
    # Top of a curled receipt: prices sit half a row above their items' left ends
    pieces = [
        ("€2.50", 713, 784, 372, 370, 30), ("1 Tesco 20 Tie Top Refuse Bag 501", 271, 650, 389, 374, 24),
        ("€13.49", 701, 783, 397, 395, 28), ("1 Tesco Fillets 1171g", 269, 514, 415, 406, 22),
        ("-€1.00", 708, 787, 419, 419, 30), ("Cc €12.49", 302, 413, 437, 433, 26),
        ("€4.15", 714, 785, 444, 444, 28), ("1 Tesco Chicken Oyster Thigh 1.203kg", 267, 690, 457, 446, 28),
    ]
    assert rows(pieces) == [
        "1 Tesco 20 Tie Top Refuse Bag 501 €2.50", "1 Tesco Fillets 1171g €13.49",
        "Cc €12.49 -€1.00", "1 Tesco Chicken Oyster Thigh 1.203kg €4.15",
    ]


def test_faded_minus_signs_dont_pull_summary_amounts_off_their_line():
    pieces = [("Savings", 270, 360, 400, 400, 30), ("€4.23", 740, 810, 398, 398, 30),
              ("Promotions", 300, 430, 430, 430, 30), ("€2.15", 740, 810, 428, 428, 30)]
    assert rows(pieces) == ["Savings €4.23", "Promotions €2.15"]
