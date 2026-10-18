# backend/app/services/money.py

"""
Money helpers. Amounts are integers in a currency's minor unit (cents, paise...).
Never use floats for money: parse with Decimal, store and add integers.
"""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Sequence

# ISO 4217 code -> (decimal places, symbol, name)
CURRENCIES: dict[str, tuple[int, str, str]] = {
    "INR": (2, "₹", "Indian Rupee"),
    "EUR": (2, "€", "Euro"),
    "USD": (2, "$", "US Dollar"),
    "GBP": (2, "£", "British Pound"),
    "AUD": (2, "A$", "Australian Dollar"),
    "CAD": (2, "C$", "Canadian Dollar"),
    "NZD": (2, "NZ$", "New Zealand Dollar"),
    "CHF": (2, "CHF", "Swiss Franc"),
    "SEK": (2, "kr", "Swedish Krona"),
    "NOK": (2, "kr", "Norwegian Krone"),
    "DKK": (2, "kr", "Danish Krone"),
    "PLN": (2, "zł", "Polish Złoty"),
    "CZK": (2, "Kč", "Czech Koruna"),
    "HUF": (2, "Ft", "Hungarian Forint"),
    "TRY": (2, "₺", "Turkish Lira"),
    "ZAR": (2, "R", "South African Rand"),
    "AED": (2, "AED", "UAE Dirham"),
    "SAR": (2, "SAR", "Saudi Riyal"),
    "QAR": (2, "QAR", "Qatari Riyal"),
    "KWD": (3, "KD", "Kuwaiti Dinar"),
    "BHD": (3, "BD", "Bahraini Dinar"),
    "OMR": (3, "OMR", "Omani Rial"),
    "SGD": (2, "S$", "Singapore Dollar"),
    "HKD": (2, "HK$", "Hong Kong Dollar"),
    "CNY": (2, "¥", "Chinese Yuan"),
    "JPY": (0, "¥", "Japanese Yen"),
    "KRW": (0, "₩", "South Korean Won"),
    "THB": (2, "฿", "Thai Baht"),
    "MYR": (2, "RM", "Malaysian Ringgit"),
    "IDR": (2, "Rp", "Indonesian Rupiah"),
    "PHP": (2, "₱", "Philippine Peso"),
    "PKR": (2, "Rs", "Pakistani Rupee"),
    "BDT": (2, "৳", "Bangladeshi Taka"),
    "LKR": (2, "Rs", "Sri Lankan Rupee"),
    "NPR": (2, "Rs", "Nepalese Rupee"),
    "BRL": (2, "R$", "Brazilian Real"),
    "MXN": (2, "MX$", "Mexican Peso"),
    "ILS": (2, "₪", "Israeli Shekel"),
    "EGP": (2, "E£", "Egyptian Pound"),
    "NGN": (2, "₦", "Nigerian Naira"),
    "KES": (2, "KSh", "Kenyan Shilling"),
}


class MoneyError(ValueError):
    pass


def is_supported(currency: str | None) -> bool:
    return bool(currency) and currency.upper() in CURRENCIES


def exponent(currency: str) -> int:
    try:
        return CURRENCIES[currency.upper()][0]
    except KeyError:
        raise MoneyError(f"Unsupported currency: {currency}")


def parse_decimal(value: str | int | float | Decimal) -> Decimal:
    """'1,234.50', '12,30' (decimal comma), ' -3.00 ', 12 -> Decimal."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    text = str(value).strip().replace(" ", "").replace(" ", "").replace("−", "-")  # U+2212 minus sign
    for symbol in ("€", "$", "£", "₹", "¥"):
        text = text.replace(symbol, "")
    if "," in text and "." in text:
        # the last separator is the decimal one
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        whole, _, frac = text.rpartition(",")
        text = f"{whole.replace(',', '')}.{frac}" if len(frac) in (1, 2) else text.replace(",", "")
    try:
        return Decimal(text)
    except InvalidOperation:
        raise MoneyError(f"Not a number: {value!r}")


def to_minor(value: str | int | float | Decimal, currency: str) -> int:
    """Major-unit amount (e.g. '12.30') -> minor units (1230), rounded half-up."""
    places = exponent(currency)
    amount = parse_decimal(value)
    return int((amount * (Decimal(10) ** places)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def to_major(minor: int, currency: str) -> Decimal:
    places = exponent(currency)
    return (Decimal(minor) / (Decimal(10) ** places)).quantize(Decimal(1) / (Decimal(10) ** places))


def format_minor(minor: int, currency: str) -> str:
    symbol = CURRENCIES[currency.upper()][1]
    places = exponent(currency)
    major = to_major(abs(minor), currency)
    text = f"{major:,.{places}f}"
    return f"{'-' if minor < 0 else ''}{symbol}{text}"


def allocate(total: int, weights: Sequence[int | float | Decimal]) -> list[int]:
    """
    Split an integer amount by weights so the parts add up exactly to `total`
    (largest-remainder method). Leftover units go to the largest fractional parts,
    ties to the earlier position. All-zero weights split equally. Works for negative totals.
    """
    count = len(weights)
    if count == 0:
        if total != 0:
            raise MoneyError("Nothing to allocate to")
        return []
    decimals = [Decimal(str(w)) if not isinstance(w, Decimal) else w for w in weights]
    if any(w < 0 for w in decimals):
        raise MoneyError("Weights can't be negative")
    weight_sum = sum(decimals)
    if weight_sum == 0:
        decimals = [Decimal(1)] * count
        weight_sum = Decimal(count)

    sign = -1 if total < 0 else 1
    magnitude = abs(total)
    exact = [magnitude * w / weight_sum for w in decimals]
    parts = [int(e) for e in exact]  # floor (values are non-negative)
    leftover = magnitude - sum(parts)
    order = sorted(range(count), key=lambda i: (-(exact[i] - parts[i]), i))
    for i in order[:leftover]:
        parts[i] += 1
    return [sign * p for p in parts]
