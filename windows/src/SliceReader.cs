using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Beam
{
    // Reads a download off the network in slices for the file, up to 256 KB each. It keeps reading while more is right
    // there and hands over what came as soon as the next read has to wait (after a moment's grace, at most ~16 ms per
    // slice, so bytes in flight still join). So nothing sits unwritten in memory while a sender pauses or a link
    // stalls, and a fast transfer still writes big slices, also over HTTPS, where one read returns at most one 16 KB
    // TLS record. The read that had to wait carries over into the next slice. `onRead` runs after every read (the
    // stall watchdog's sign of life).
    // No dependencies on the rest of Beam: test\perf\windows-https-read.ps1 compiles it on its own.
    sealed class SliceReader
    {
        public const int Piece = 64 * 1024, Most = 256 * 1024;
        const int GraceMs = 10;
        readonly Stream stream;
        readonly Action onRead;
        readonly CancellationToken token;
        Task<int> waiting;      // a read still under way when the last slice was handed over
        byte[] waitingBuffer;   // ...and where it writes: the previous slice's buffer, after that slice's bytes
        int waitingAt;
        bool ended;

        public SliceReader(Stream stream, Action onRead, CancellationToken token)
        {
            this.stream = stream;
            this.onRead = onRead;
            this.token = token;
        }

        // Fills `buffer` from its start and returns the count; 0 = the end of the response. The buffer of the previous
        // slice must stay untouched until this returns (the read carried over from it may still write after its bytes).
        public async Task<int> Next(byte[] buffer)
        {
            if (ended) return 0;
            int got = 0;
            if (waiting != null)
            {
                var read = waiting;
                waiting = null;
                int n = await read.ConfigureAwait(false);
                if (n == 0) { ended = true; waitingBuffer = null; return 0; }
                onRead();
                Buffer.BlockCopy(waitingBuffer, waitingAt, buffer, 0, n);
                waitingBuffer = null;
                got = n;
            }
            Task grace = null; // one timer per slice, from its first read that had to wait
            while (got < Most && got < buffer.Length)
            {
                var read = stream.ReadAsync(buffer, got, Math.Min(Piece, buffer.Length - got), token);
                if (got > 0 && !read.IsCompleted)
                {
                    if (grace == null) grace = Task.Delay(GraceMs);
                    if (!grace.IsCompleted) await Task.WhenAny(read, grace).ConfigureAwait(false);
                    if (!read.IsCompleted)
                    {
                        waiting = read;
                        waitingBuffer = buffer;
                        waitingAt = got;
                        return got;
                    }
                }
                int n = await read.ConfigureAwait(false);
                if (n == 0) { ended = true; break; }
                onRead();
                got += n;
            }
            return got;
        }

        // The response is being dropped: a read still under way ends with an error nobody waits for.
        public void Abandon()
        {
            var read = waiting;
            waiting = null;
            waitingBuffer = null;
            if (read != null) read.ContinueWith(t => { var ignored = t.Exception; }, TaskContinuationOptions.ExecuteSynchronously);
        }
    }
}
