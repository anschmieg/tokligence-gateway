"""Classify peer shutdown without confusing a reset with a read timeout."""
def observe_peer_close(connection):
    try:
        data = connection.recv(1)
    except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
        return 'reset'
    except TimeoutError:
        return 'timeout'
    return 'eof' if data == b'' else 'unexpected_data'
