import threading

import pytest

from app.circuit_breaker import FAILURE, NOT_COUNTED, SUCCESS, CircuitBreaker, CircuitOpen


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def record(breaker, outcome, times=1):
    for _ in range(times):
        breaker.after(breaker.before(), outcome)


def test_stays_closed_below_ten_calls_even_if_all_fail():
    breaker = CircuitBreaker(clock=Clock())
    record(breaker, FAILURE, 9)
    assert not breaker.is_open
    breaker.before()  # nie rzuca


def test_opens_at_half_failures_of_last_ten():
    breaker = CircuitBreaker(clock=Clock())
    record(breaker, SUCCESS, 5)
    record(breaker, FAILURE, 4)
    assert not breaker.is_open
    record(breaker, FAILURE)  # 5 z 10
    assert breaker.is_open
    with pytest.raises(CircuitOpen):
        breaker.before()


def test_only_last_ten_results_count():
    breaker = CircuitBreaker(clock=Clock())
    record(breaker, FAILURE, 4)
    record(breaker, SUCCESS, 10)  # stare awarie wypadają z okna
    record(breaker, FAILURE, 4)
    assert not breaker.is_open


def test_not_counted_results_do_not_fill_the_window():
    breaker = CircuitBreaker(clock=Clock())
    record(breaker, NOT_COUNTED, 20)
    record(breaker, FAILURE, 9)
    assert not breaker.is_open  # dopiero 9 wyników w oknie
    record(breaker, FAILURE)
    assert breaker.is_open


def test_one_probe_after_cooldown_success_closes():
    clock = Clock()
    breaker = CircuitBreaker(clock=clock)
    record(breaker, FAILURE, 10)
    clock.now += 29.9
    with pytest.raises(CircuitOpen):
        breaker.before()
    clock.now += 0.2
    probe = breaker.before()
    with pytest.raises(CircuitOpen):
        breaker.before()  # w trakcie próby pozostali dostają od razu odmowę
    breaker.after(probe, SUCCESS)
    assert not breaker.is_open
    record(breaker, FAILURE, 9)  # okno zaczyna się od nowa
    assert not breaker.is_open


def test_failed_probe_opens_for_another_cooldown():
    clock = Clock()
    breaker = CircuitBreaker(clock=clock)
    record(breaker, FAILURE, 10)
    clock.now += 30
    breaker.after(breaker.before(), FAILURE)
    assert breaker.is_open
    clock.now += 29
    with pytest.raises(CircuitOpen):
        breaker.before()
    clock.now += 1
    breaker.after(breaker.before(), SUCCESS)
    assert not breaker.is_open


def test_probe_answered_with_a_not_counted_result_closes():
    clock = Clock()
    breaker = CircuitBreaker(clock=clock)
    record(breaker, FAILURE, 10)
    clock.now += 30
    breaker.after(breaker.before(), NOT_COUNTED)  # usługa odpowiedziała (np. 2xx niezgodne z kontraktem)
    assert not breaker.is_open


def test_result_of_a_call_started_before_opening_is_ignored():
    clock = Clock()
    breaker = CircuitBreaker(clock=clock)
    slow = breaker.before()
    record(breaker, FAILURE, 10)
    breaker.after(slow, SUCCESS)  # nie zamyka wyłącznika
    assert breaker.is_open


def test_lock_is_not_held_during_the_call():
    breaker = CircuitBreaker(clock=Clock())
    first = breaker.before()  # wywołanie trwa
    started = threading.Event()

    def second_call():
        breaker.after(breaker.before(), SUCCESS)
        started.set()

    threading.Thread(target=second_call).start()
    assert started.wait(1)  # drugie wywołanie nie czeka na koniec pierwszego
    breaker.after(first, SUCCESS)


def test_parallel_threads_keep_a_consistent_state():
    breaker = CircuitBreaker(clock=Clock())

    def worker():
        for _ in range(200):
            try:
                breaker.after(breaker.before(), FAILURE)
            except CircuitOpen:
                pass

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert breaker.is_open
