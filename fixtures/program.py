# deterministic debug fixture: line numbers are load-bearing for the tests
import sys


def helper(n):
    total = 0
    for i in range(n):
        total += i          # line 8: breakpoint inside a call
    return total


def main():
    ledger = {"capabilities": 17, "verified": 12}
    count = ledger["capabilities"]          # line 14
    print("ledger:", count, "capabilities", flush=True)  # line 15
    result = helper(count)                   # line 16
    print("result:", result, flush=True)     # line 17
    return result                            # line 18


if __name__ == "__main__":
    sys.exit(0 if main() == 136 else 3)
